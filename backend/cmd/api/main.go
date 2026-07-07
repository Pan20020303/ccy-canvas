package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	announcementshttp "ccy-canvas/backend/internal/announcements/interfaces"
	creditapp "ccy-canvas/backend/internal/credits/application"
	creditinfra "ccy-canvas/backend/internal/credits/infrastructure"
	identityapp "ccy-canvas/backend/internal/identity/application"
	identityinfra "ccy-canvas/backend/internal/identity/infrastructure"
	identityhttp "ccy-canvas/backend/internal/identity/interfaces"
	"ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/modelcatalog/infrastructure"
	modelhttp "ccy-canvas/backend/internal/modelcatalog/interfaces"
	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/cache"
	"ccy-canvas/backend/internal/platform/config"
	"ccy-canvas/backend/internal/platform/database"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/events"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/platform/password"
	"ccy-canvas/backend/internal/platform/session"
	"ccy-canvas/backend/internal/presence"
	"ccy-canvas/backend/internal/shared/httpx"
	skillsapp "ccy-canvas/backend/internal/skills/application"
	skillshttp "ccy-canvas/backend/internal/skills/interfaces"
	"ccy-canvas/backend/internal/tasks"
	workspaceinfra "ccy-canvas/backend/internal/workspace/infrastructure"
	workspacehttp "ccy-canvas/backend/internal/workspace/interfaces"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	ctx := context.Background()
	pool, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	queries := sqlc.New(pool)
	sessionManager := session.NewManager(cfg.SessionSecret, cfg.CookieSecure)
	passwordService := password.NewService()

	if report, err := skillsapp.EnsureCreatorSuiteSeeds(ctx, queries); err != nil {
		log.Printf("[skills] creator-suite seed import skipped: %v", err)
	} else if report.Created > 0 || report.Updated > 0 {
		log.Printf("[skills] creator-suite seed import created=%d updated=%d existing=%d total=%d", report.Created, report.Updated, report.Existing, report.Total)
	}
	if report, err := skillsapp.EnsureCreatorSuiteAgentSeeds(ctx, queries); err != nil {
		log.Printf("[agents] creator-suite agent seed import skipped: %v", err)
	} else if report.Created > 0 || report.Updated > 0 {
		log.Printf("[agents] creator-suite agent seed import created=%d updated=%d existing=%d total=%d", report.Created, report.Updated, report.Existing, report.Total)
	}

	// Identity & Auth
	creditService := creditinfra.NewService(queries)
	identityRepository := identityinfra.NewRepository(pool, queries)
	identityService := identityapp.NewService(identityRepository, passwordService, creditService).
		WithDefaultDailyQuota(cfg.DefaultDailyQuota)
	identityHandler := identityhttp.NewHandler(
		identityService,
		creditService,
		sessionManager,
		identityhttp.WithGoogleOAuth(identityhttp.GoogleOAuthConfig{
			ClientID:        cfg.GoogleOAuthClientID,
			ClientSecret:    cfg.GoogleOAuthSecret,
			RedirectURL:     cfg.GoogleOAuthRedirectURL,
			FrontendBaseURL: cfg.AuthFrontendBaseURL,
			CookieSecure:    cfg.CookieSecure,
		}),
	)
	if cfg.GoogleOAuthClientID != "" && cfg.GoogleOAuthSecret != "" {
		log.Printf("[auth] Google OAuth enabled")
	}

	// Model Catalog
	catalogRepo := infrastructure.NewRepository(queries)
	taskBus := application.NewTaskEventBus()
	// F7: with Redis available, fan task-completion events across replicas
	// so the SSE stream works even when the finishing worker and the
	// client's SSE connection live in different backend processes. Without
	// Redis the bus delivers in-process (single-replica) — unchanged.
	if cfg.RedisAddr != "" {
		transport := events.NewRedisTransport(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB)
		taskBus = taskBus.WithTransport(transport)
		go taskBus.StartBridge(context.Background())
	}

	// Live-collaboration presence bus (project-scoped, purely ephemeral). Same
	// cross-replica pattern as the task bus — needs Redis for multi-replica so
	// presence from a client on another replica is visible here. The sweeper
	// evicts ghosts whose leave frame was missed.
	presenceBus := presence.NewBus()
	if cfg.RedisAddr != "" {
		presenceBus = presenceBus.WithTransport(events.NewRedisTransport(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB))
		go presenceBus.StartBridge(context.Background())
	}
	go presenceBus.StartSweeper(context.Background())
	catalogService := application.NewService(catalogRepo, cfg.EncryptionKey).
		WithEventBus(taskBus).
		WithCredits(creditChargerAdapter{svc: creditService})
	var redisCache *cache.JSONCache
	if cfg.RedisAddr != "" {
		redisCache = cache.NewJSONCache(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB, "ccy")
		catalogService = catalogService.WithCache(redisCache)
		log.Printf("[cache] Redis cache enabled: %s db=%d policy=%s", cfg.RedisAddr, cfg.RedisDB, cfg.ChannelPolicy)
	}
	// Optional NewAPI gateway. If NEWAPI_BASE_URL is empty the client is
	// nil and Service falls back to the legacy per-ProviderConfig path
	// — keeps the migration risk-free per Stage P1 in the runbook.
	if cfg.NewAPIBaseURL != "" && cfg.NewAPIToken != "" {
		newapiClient := application.NewNewAPIClient(cfg.NewAPIBaseURL, cfg.NewAPIToken, cfg.NewAPITimeout)
		catalogService = catalogService.WithNewAPI(newapiClient)
		log.Printf("[modelcatalog] NewAPI gateway enabled: %s (timeout=%ds)", cfg.NewAPIBaseURL, cfg.NewAPITimeout)
	}
	catalogHandler := modelhttp.NewHandler(catalogService, queries).WithCache(redisCache)

	// Optional Asynq task queue. When REDIS_ADDR is set, the generation
	// handler enqueues durable tasks instead of running inline. The
	// worker server runs in a background goroutine. Empty REDIS_ADDR
	// keeps the legacy detached-goroutine path (no behavior change).
	var taskWorker *tasks.Worker
	if cfg.RedisAddr != "" {
		taskQueue := tasks.NewQueue(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB)
		taskWorker = tasks.NewWorker(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB, catalogService, queries)
		queueAdapter := taskQueueAdapter{q: taskQueue}
		catalogService = catalogService.WithAssetPersistQueue(queueAdapter)
		catalogHandler = catalogHandler.WithTasks(queueAdapter)
		go func() {
			log.Printf("[tasks] Asynq worker starting (redis=%s db=%d)", cfg.RedisAddr, cfg.RedisDB)
			if err := taskWorker.Start(); err != nil {
				log.Printf("[tasks] Asynq worker exited: %v", err)
			}
		}()
		log.Printf("[tasks] Asynq queue enabled: %s db=%d", cfg.RedisAddr, cfg.RedisDB)
	} else {
		// F5: without Redis the generation path falls back to a detached
		// in-process goroutine. It does NOT survive a backend crash/restart
		// — an in-flight task is lost (the reaper will later mark its row
		// 'error' so the UI doesn't hang, but the result is gone). Production
		// deployments should set REDIS_ADDR to get durable, restart-safe
		// task delivery.
		log.Printf("[tasks] WARNING REDIS_ADDR not set — using legacy in-process generation (no durability across restarts). Set REDIS_ADDR in production.")
	}

	allowedOrigins := []string{
		"http://localhost:5173",
		"http://127.0.0.1:5173",
		"http://localhost:5174",
		"http://127.0.0.1:5174",
	}
	allowedOriginSet := map[string]struct{}{}
	for _, origin := range allowedOrigins {
		allowedOriginSet[origin] = struct{}{}
	}

	router := chi.NewMux()
	router.Use(middleware.RealIP)
	router.Use(httpx.RequestIDMiddleware)
	router.Use(httpx.CORSMiddleware(allowedOrigins))
	router.Use(httpx.MaxBodyMiddleware(50 * 1024 * 1024)) // 50 MB cap for JSON endpoints; uploads use their own cap
	router.Use(middleware.Logger)
	router.Options("/*", func(w http.ResponseWriter, r *http.Request) {
		httpx.ApplyCORSHeaders(w, r, allowedOriginSet)
		w.WriteHeader(http.StatusNoContent)
	})
	router.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, r, http.StatusOK, map[string]string{"status": "ok"})
	})

	// File upload + static file serving.
	workspacehttp.RegisterUploadRoutes(router, sessionManager)
	// User-scoped generation-history persistence (formerly localStorage-only).
	workspacehttp.RegisterHistoryRoutes(router, sessionManager, queries)
	// User-scoped asset-library persistence (formerly localStorage-only).
	workspacehttp.RegisterAssetRoutes(router, sessionManager, queries)
	// Collaboration support (invite-by-username user lookup).
	workspacehttp.RegisterCollabRoutes(router, sessionManager, queries)
	fileServer := http.StripPrefix("/uploads/", http.FileServer(http.Dir("uploads")))
	router.Get("/uploads/*", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000")
		// Prevent MIME sniffing of stored assets — defense-in-depth alongside
		// the upload-time content sniffing that rejects active document types.
		w.Header().Set("X-Content-Type-Options", "nosniff")
		fileServer.ServeHTTP(w, r)
	})

	// Existing chi identity routes (login / register / logout / me / invitations).
	identityHandler.Routes(router)

	// Huma API: OpenAPI 3.1 at /api/openapi.json + per-operation auth middleware.
	api := httpapi.New(router)
	api.UseMiddleware(authn.Middleware(api, sessionManager))

	// Admin management routes (users, invitations, stats, logs).
	adminHandler := identityhttp.NewAdminHandler(queries, passwordService)
	adminHandler.RegisterRoutes(api)

	// Model catalog routes.
	catalogHandler.RegisterRoutes(api)

	// Workspace routes (projects + canvas).
	workspaceRepo := workspaceinfra.NewRepository(queries)
	workspaceHandler := workspacehttp.NewHandler(workspaceRepo)
	workspaceHandler.RegisterRoutes(api)
	// Live-collaboration presence (chi-direct: SSE stream + throttled report).
	workspacehttp.RegisterPresenceRoutes(router, sessionManager, presenceBus, workspaceRepo)

	// Skills + Agents routes (user CRUD + invoke + admin CRUD).
	skillsExecutor := skillsapp.NewExecutor(catalogService)
	skillsHandler := skillshttp.NewHandler(queries, skillsExecutor)
	skillsHandler.RegisterRoutes(api)
	skillsAdminHandler := skillshttp.NewAdminHandler(queries)
	skillsAdminHandler.RegisterRoutes(api)

	// Announcements routes (admin publish/delete + user-visible list for the bell).
	announcementsHandler := announcementshttp.NewHandler(queries)
	announcementsHandler.RegisterRoutes(api)

	// Agent SSE run endpoint sits on chi directly (huma envelopes JSON,
	// which would break Server-Sent Events).
	agentRunRouter := skillshttp.NewAgentRunRouter(queries, skillsExecutor, catalogService, sessionManager)
	agentRunRouter.RegisterChi(router)

	// Task-completion SSE stream — same chi-direct rationale as above.
	taskStreamRouter := modelhttp.NewTaskStreamRouter(taskBus, sessionManager)
	taskStreamRouter.RegisterChi(router)

	// Graceful-shutdown context: cancelled on SIGINT/SIGTERM so the HTTP server
	// drains in-flight requests (canvas saves, uploads, submits) instead of
	// cutting them mid-flight, and background workers stop cleanly. In-flight
	// generations survive regardless via the durable Asynq queue.
	shutdownCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Stale-task reaper (F3). Runs regardless of REDIS so the legacy inline
	// path is covered too: any generation_logs row stuck active past its
	// runtime budget (OOM-killed worker, crashed goroutine, double-failed
	// persist) gets marked 'error' and the node stops spinning. Cheap
	// indexed query; ticks every minute. Stops on shutdown.
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-shutdownCtx.Done():
				return
			case <-ticker.C:
				rctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				if _, err := catalogService.ReapStaleGenerations(rctx); err != nil {
					log.Printf("[tasks] reaper tick failed: %v", err)
				}
				cancel()
			}
		}
	}()

	srv := &http.Server{Addr: cfg.HTTPAddr, Handler: router}
	go func() {
		log.Printf("listening on %s", cfg.HTTPAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	<-shutdownCtx.Done()
	log.Printf("shutdown signal received — draining in-flight requests (up to 25s)…")
	stop() // restore default signal handling so a second Ctrl-C force-quits

	drainCtx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	if err := srv.Shutdown(drainCtx); err != nil {
		log.Printf("http shutdown: %v", err)
	}
	if taskWorker != nil {
		// Let the currently-processing job finish; any unacked task stays in
		// Redis and is re-delivered after restart (no generation lost).
		taskWorker.Shutdown()
	}
	log.Printf("shutdown complete")
}

// creditChargerAdapter bridges the credits service to the modelcatalog
// service's credit hook, translating the credits package's
// ErrInsufficientCredits sentinel into the modelcatalog one so the HTTP
// handler can detect it without importing the credits package.
type creditChargerAdapter struct {
	svc creditinfra.Service
}

func (a creditChargerAdapter) Reserve(ctx context.Context, userID string, amount int32, reason string) error {
	if err := a.svc.Reserve(ctx, userID, amount, reason); err != nil {
		if errors.Is(err, creditapp.ErrInsufficientCredits) {
			return application.ErrInsufficientCredits
		}
		return err
	}
	return nil
}

func (a creditChargerAdapter) Refund(ctx context.Context, userID string, amount int32, reason string) error {
	return a.svc.Refund(ctx, userID, amount, reason)
}

// taskQueueAdapter bridges *tasks.Queue (concrete type, owns Redis
// connection) to the modelhttp.TaskEnqueuer interface (narrow contract
// the handler depends on). Defined here in main so the modelcatalog
// package stays free of the tasks package import.
type taskQueueAdapter struct {
	q *tasks.Queue
}

func (a taskQueueAdapter) Enabled() bool {
	return a.q != nil && a.q.Enabled()
}

func (a taskQueueAdapter) Enqueue(ctx context.Context, p modelhttp.TaskGenerationPayload) (string, error) {
	return a.q.Enqueue(ctx, tasks.GenerationPayload{
		LogID:       p.LogID,
		RequestID:   p.RequestID,
		UserID:      p.UserID,
		ServiceType: p.ServiceType,
		Model:       p.Model,
		NodeID:      p.NodeID,
	})
}

func (a taskQueueAdapter) EnqueueAssetPersist(ctx context.Context, p application.AssetPersistPayload) (string, error) {
	return a.q.EnqueueAssetPersist(ctx, tasks.AssetPersistPayload{
		LogID:       p.LogID,
		UserID:      p.UserID,
		NodeID:      p.NodeID,
		ServiceType: p.ServiceType,
		StagingPath: p.StagingPath,
		StagingURL:  p.StagingURL,
		COSKey:      p.COSKey,
		ContentType: p.ContentType,
		EnqueuedAt:  p.EnqueuedAt,
	})
}
