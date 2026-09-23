package interfaces

import (
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgtype"
)

func parseUUID(s string) (pgtype.UUID, error) {
	var u pgtype.UUID
	if len(s) != 36 {
		return u, huma.Error400BadRequest("Invalid UUID format")
	}
	hex := s[0:8] + s[9:13] + s[14:18] + s[19:23] + s[24:36]
	for i := 0; i < 16; i++ {
		hi := hexVal(hex[i*2])
		lo := hexVal(hex[i*2+1])
		if hi == 0xFF || lo == 0xFF {
			return u, huma.Error400BadRequest("Invalid UUID format")
		}
		u.Bytes[i] = hi<<4 | lo
	}
	u.Valid = true
	return u, nil
}

func parseUUIDList(ss []string) ([]pgtype.UUID, error) {
	out := make([]pgtype.UUID, 0, len(ss))
	for _, s := range ss {
		u, err := parseUUID(s)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, nil
}

func hexVal(b byte) byte {
	switch {
	case b >= '0' && b <= '9':
		return b - '0'
	case b >= 'a' && b <= 'f':
		return b - 'a' + 10
	case b >= 'A' && b <= 'F':
		return b - 'A' + 10
	}
	return 0xFF
}

func formatUUID(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	const hex = "0123456789abcdef"
	buf := make([]byte, 36)
	pos := 0
	for i, v := range u.Bytes {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			buf[pos] = '-'
			pos++
		}
		buf[pos] = hex[v>>4]
		buf[pos+1] = hex[v&0x0f]
		pos += 2
	}
	return string(buf)
}

func formatTime(t pgtype.Timestamptz) string {
	if !t.Valid {
		return ""
	}
	return t.Time.Format(time.RFC3339)
}
