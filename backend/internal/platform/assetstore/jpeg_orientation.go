package assetstore

import (
	"bufio"
	"encoding/binary"
	"image"
	"image/color"
	"io"
)

// Read only bounded JPEG headers. The original remains unchanged; orientation
// is applied while sampling the derivative to match browser image rendering.
func jpegOrientation(source io.Reader) int {
	r := bufio.NewReader(io.LimitReader(source, 1<<20))
	var pair [2]byte
	if _, err := io.ReadFull(r, pair[:]); err != nil || pair != [2]byte{0xff, 0xd8} {
		return 1
	}
	for count := 0; count < 128; count++ {
		marker, err := r.ReadByte()
		if err != nil || marker != 0xff {
			return 1
		}
		for marker == 0xff {
			marker, err = r.ReadByte()
			if err != nil {
				return 1
			}
		}
		if marker == 0xda || marker == 0xd9 {
			return 1
		}
		if marker == 0x01 || (marker >= 0xd0 && marker <= 0xd8) {
			continue
		}
		if _, err = io.ReadFull(r, pair[:]); err != nil {
			return 1
		}
		size := int(binary.BigEndian.Uint16(pair[:])) - 2
		if size < 0 {
			return 1
		}
		payload := make([]byte, size)
		if _, err = io.ReadFull(r, payload); err != nil {
			return 1
		}
		if marker == 0xe1 && len(payload) >= 14 && string(payload[:6]) == "Exif\x00\x00" {
			return tiffOrientation(payload[6:])
		}
	}
	return 1
}

func tiffOrientation(data []byte) int {
	if len(data) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(data[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	if order.Uint16(data[2:4]) != 42 {
		return 1
	}
	offset := uint64(order.Uint32(data[4:8]))
	if offset+2 > uint64(len(data)) {
		return 1
	}
	count := int(order.Uint16(data[offset : offset+2]))
	offset += 2
	for i := 0; i < count && offset+12 <= uint64(len(data)); i++ {
		entry := data[offset : offset+12]
		offset += 12
		if order.Uint16(entry[:2]) == 0x112 && order.Uint16(entry[2:4]) == 3 && order.Uint32(entry[4:8]) == 1 {
			orientation := int(order.Uint16(entry[8:10]))
			if orientation >= 1 && orientation <= 8 {
				return orientation
			}
		}
	}
	return 1
}

type orientedImage struct {
	image.Image
	orientation int
}

func (im orientedImage) Bounds() image.Rectangle {
	b := im.Image.Bounds()
	if im.orientation >= 5 {
		return image.Rect(0, 0, b.Dy(), b.Dx())
	}
	return image.Rect(0, 0, b.Dx(), b.Dy())
}
func (im orientedImage) At(x, y int) color.Color {
	b := im.Image.Bounds()
	w, h := b.Dx(), b.Dy()
	switch im.orientation {
	case 2:
		x = w - 1 - x
	case 3:
		x, y = w-1-x, h-1-y
	case 4:
		y = h - 1 - y
	case 5:
		x, y = y, x
	case 6:
		x, y = y, h-1-x
	case 7:
		x, y = w-1-y, h-1-x
	case 8:
		x, y = w-1-y, x
	}
	return im.Image.At(b.Min.X+x, b.Min.Y+y)
}
