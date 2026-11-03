package adminsystem

import (
	"ccy-canvas/backend/internal/platform/assetstore"
	"context"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

type Usage struct {
	Total     uint64  `json:"total"`
	Used      uint64  `json:"used"`
	Available uint64  `json:"available"`
	Percent   float64 `json:"percent"`
}
type ResourceSnapshot struct {
	SampledAt         time.Time `json:"sampled_at"`
	Hostname          string    `json:"hostname"`
	OS                string    `json:"os"`
	Arch              string    `json:"arch"`
	CPUCores          int       `json:"cpu_cores"`
	CPUPercent        *float64  `json:"cpu_percent"`
	Memory            *Usage    `json:"memory"`
	Disk              *Usage    `json:"disk"`
	DiskPath          string    `json:"disk_path"`
	UptimeSeconds     int64     `json:"uptime_seconds"`
	GoVersion         string    `json:"go_version"`
	HeapBytes         uint64    `json:"heap_bytes"`
	HeapReservedBytes uint64    `json:"heap_reserved_bytes"`
	RuntimeBytes      uint64    `json:"runtime_bytes"`
	Goroutines        int       `json:"goroutines"`
	GCCount           uint32    `json:"gc_count"`
	Warnings          []string  `json:"warnings"`
}
type Metrics struct {
	mu      sync.Mutex
	started time.Time
	cached  ResourceSnapshot
}

func NewMetrics() *Metrics { return &Metrics{started: time.Now()} }
func (m *Metrics) Snapshot(parent context.Context) ResourceSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.cached.SampledAt.IsZero() && time.Since(m.cached.SampledAt) < 5*time.Second {
		return m.cached
	}
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	host, _ := os.Hostname()
	s := ResourceSnapshot{Hostname: host, OS: runtime.GOOS, Arch: runtime.GOARCH, CPUCores: runtime.NumCPU(), GoVersion: runtime.Version(), UptimeSeconds: int64(time.Since(m.started).Seconds()), Goroutines: runtime.NumGoroutine(), Warnings: []string{}}
	if v, err := cpu.PercentWithContext(ctx, 200*time.Millisecond, false); err == nil && len(v) > 0 {
		s.CPUPercent = &v[0]
	} else {
		s.Warnings = append(s.Warnings, "CPU 数据暂不可用")
	}
	if v, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		s.Memory = &Usage{v.Total, v.Used, v.Available, v.UsedPercent}
	} else {
		s.Warnings = append(s.Warnings, "内存数据暂不可用")
	}
	path, err := filepath.Abs(assetstore.LocalRoot())
	if err == nil {
		// The upload directory may not exist until the first local upload.
		for {
			if _, err := os.Stat(path); err == nil {
				break
			}
			parent := filepath.Dir(path)
			if parent == path {
				break
			}
			path = parent
		}
		s.DiskPath = path
		if v, err := disk.UsageWithContext(ctx, path); err == nil {
			s.Disk = &Usage{v.Total, v.Used, v.Free, v.UsedPercent}
		} else {
			s.Warnings = append(s.Warnings, "磁盘数据暂不可用")
		}
	} else {
		s.Warnings = append(s.Warnings, "无法解析上传目录")
	}
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	s.HeapBytes = stats.HeapAlloc
	s.HeapReservedBytes = stats.HeapSys
	s.RuntimeBytes = stats.Sys
	s.GCCount = stats.NumGC
	s.SampledAt = time.Now().UTC()
	m.cached = s
	return s
}
