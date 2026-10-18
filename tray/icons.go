package main

// The tray icons, drawn here rather than shipped as files: a box (a job's
// container) in the state's colour, filled while a job runs (two frames),
// with two bars when paused, a slash when offline, a "!" when the agent is
// down, and a red dot when the newest run failed. PNG for Linux; Windows
// wants an .ico, which holds the PNG as is.

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
)

const iconSize = 32

type shape func(x, y float64) bool

type layer struct {
	shape shape
	color color.NRGBA
}

func roundedRect(x0, y0, x1, y1, r float64) shape {
	return func(x, y float64) bool {
		if x < x0 || x > x1 || y < y0 || y > y1 {
			return false
		}
		cx := math.Max(x0+r, math.Min(x, x1-r))
		cy := math.Max(y0+r, math.Min(y, y1-r))
		return (x-cx)*(x-cx)+(y-cy)*(y-cy) <= r*r
	}
}

func rect(x0, y0, x1, y1 float64) shape {
	return func(x, y float64) bool { return x >= x0 && x <= x1 && y >= y0 && y <= y1 }
}

func circle(cx, cy, r float64) shape {
	return func(x, y float64) bool { return (x-cx)*(x-cx)+(y-cy)*(y-cy) <= r*r }
}

func segment(x0, y0, x1, y1, width float64) shape {
	return func(x, y float64) bool {
		dx, dy := x1-x0, y1-y0
		t := math.Max(0, math.Min(1, ((x-x0)*dx+(y-y0)*dy)/(dx*dx+dy*dy)))
		px, py := x0+t*dx, y0+t*dy
		return (x-px)*(x-px)+(y-py)*(y-py) <= width*width/4
	}
}

// render composites the layers with 4×4 supersampling.
func render(layers []layer) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, iconSize, iconSize))
	const samples = 4
	for py := 0; py < iconSize; py++ {
		for px := 0; px < iconSize; px++ {
			var r, g, b, a float64
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					x := float64(px) + (float64(sx)+0.5)/samples
					y := float64(py) + (float64(sy)+0.5)/samples
					var cr, cg, cb, ca float64
					for _, l := range layers {
						if !l.shape(x, y) {
							continue
						}
						la := float64(l.color.A) / 255
						cr = float64(l.color.R)*la + cr*(1-la)
						cg = float64(l.color.G)*la + cg*(1-la)
						cb = float64(l.color.B)*la + cb*(1-la)
						ca = la + ca*(1-la)
					}
					r, g, b, a = r+cr, g+cg, b+cb, a+ca
				}
			}
			n := float64(samples * samples)
			if a == 0 {
				continue
			}
			img.SetNRGBA(px, py, color.NRGBA{R: uint8(r / a), G: uint8(g / a), B: uint8(b / a), A: uint8(math.Round(a / n * 255))})
		}
	}
	return img
}

var (
	white  = color.NRGBA{255, 255, 255, 255}
	slate  = color.NRGBA{96, 112, 128, 255}
	blue   = color.NRGBA{37, 125, 230, 255}
	paleBl = color.NRGBA{120, 170, 235, 255}
	orange = color.NRGBA{232, 140, 30, 255}
	grey   = color.NRGBA{140, 140, 140, 255}
	red    = color.NRGBA{220, 50, 47, 255}
)

// IconPNG is the icon for a state; `frame` alternates while running.
func IconPNG(kind IconKind, frame int, dot bool) []byte {
	body := roundedRect(4, 8, 28, 28, 3)
	lid := roundedRect(2, 4, 30, 10, 2)
	var layers []layer
	switch kind {
	case IconRunning:
		fill := blue
		if frame%2 == 1 {
			fill = paleBl
		}
		layers = []layer{{body, fill}, {lid, fill}, {rect(4, 10, 28, 11.2), white}, {roundedRect(12, 13, 20, 16, 1), white}}
	case IconPaused:
		layers = []layer{{body, orange}, {lid, orange}, {rect(4, 10, 28, 11.2), white}, {rect(12, 14, 14.8, 25), white}, {rect(17.2, 14, 20, 25), white}}
	case IconOffline:
		layers = []layer{{body, grey}, {lid, grey}, {rect(4, 10, 28, 11.2), white}, {segment(6, 27, 26, 7, 4.5), white}, {segment(6, 27, 26, 7, 2.2), grey}}
	case IconDown:
		layers = []layer{{body, red}, {lid, red}, {rect(4, 10, 28, 11.2), white}, {roundedRect(14.6, 13, 17.4, 21.5, 1.2), white}, {circle(16, 24.5, 1.7), white}}
	default:
		layers = []layer{{body, slate}, {lid, slate}, {rect(4, 10, 28, 11.2), white}, {roundedRect(12, 13, 20, 16, 1), white}}
	}
	if dot && kind != IconDown {
		layers = append(layers, layer{circle(26, 6, 6), white}, layer{circle(26, 6, 4.6), red})
	}
	var buffer bytes.Buffer
	_ = png.Encode(&buffer, render(layers))
	return buffer.Bytes()
}

// ICO wraps a PNG in an .ico container (Windows Vista and later read PNG entries).
func ICO(pngData []byte) []byte {
	var buffer bytes.Buffer
	header := []uint16{0, 1, 1}
	_ = binary.Write(&buffer, binary.LittleEndian, header)
	entry := struct {
		Width, Height, Colors, Reserved uint8
		Planes, BitCount                uint16
		Size, Offset                    uint32
	}{iconSize, iconSize, 0, 0, 1, 32, uint32(len(pngData)), 6 + 16}
	_ = binary.Write(&buffer, binary.LittleEndian, entry)
	buffer.Write(pngData)
	return buffer.Bytes()
}
