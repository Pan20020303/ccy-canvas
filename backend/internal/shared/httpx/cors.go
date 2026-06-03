package httpx

import (
	"net"
	"net/http"
	"net/url"
)

func CORSMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		allowed[origin] = struct{}{}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ApplyCORSHeaders(w, r, allowed)

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// isLANOrigin reports whether origin is a private LAN address (RFC1918, loopback, or link-local).
// Used to auto-allow LAN clients without requiring every IP to be enumerated in config.
func isLANOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() {
		return true
	}
	return false
}

func ApplyCORSHeaders(w http.ResponseWriter, r *http.Request, allowed map[string]struct{}) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	_, exact := allowed[origin]
	if !exact && !isLANOrigin(origin) {
		// Also tolerate `*` as a wildcard for fully-open envs.
		if _, wild := allowed["*"]; !wild {
			return
		}
	}

	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Request-ID")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
}
