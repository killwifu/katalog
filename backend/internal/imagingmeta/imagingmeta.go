// Package imagingmeta — константы пайплайна изображений, безопасные для
// импорта без CGO (api-бинарник не должен линковаться с libvips).
package imagingmeta

import (
	"slices"
	"strconv"
	"strings"
)

// Derivative — то, что уходит покупателю: имя в S3-ключе и длинная
// сторона в пикселях.
type Derivative struct {
	Name string
	Px   int
}

// Derivatives — сетка деривативов, от мелкого к крупному. В ключе стоит
// имя, а не число: адрес читается глазами, и разрешение можно поменять,
// не переписывая уже разошедшиеся ссылки.
var Derivatives = []Derivative{
	{Name: "small", Px: 500},
	{Name: "medium", Px: 800},
	{Name: "large", Px: 1600},
}

// DerivativeSizes — только размеры, для кода, которому имена не нужны.
func DerivativeSizes() []int {
	sizes := make([]int, len(Derivatives))
	for i, d := range Derivatives {
		sizes[i] = d.Px
	}
	return sizes
}

// DerivativeName — имя дериватива для S3-ключа. Незнакомый размер отдаём
// числом: нестандартный ключ лучше пустого, который молча склеился бы
// в «.webp» и увёл бы отладку в сторону.
func DerivativeName(px int) string {
	for _, d := range Derivatives {
		if d.Px == px {
			return d.Name
		}
	}
	return strconv.Itoa(px)
}

// WatermarkPositions — допустимые положения водяного знака: первая буква —
// строка (t верх, m середина, b низ), вторая — столбец (l, c, r). Та же
// сетка 3×3 нарисована в кабинете. Живёт здесь, а не в imaging: настройку
// проверяет api, а ему линковаться с libvips нельзя.
var WatermarkPositions = []string{"tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"}

// WatermarkTile — знак повторяется по всему кадру, а не стоит в точках.
const WatermarkTile = "tile"

// WatermarkCells разбирает положение знака: одна или несколько точек сетки
// через запятую («tl,br») либо WatermarkTile. Пусто — правый нижний угол.
// ok=false — неизвестная точка, повтор или «tile» вперемешку с точками.
func WatermarkCells(pos string) (cells []string, ok bool) {
	if pos == "" {
		return []string{"br"}, true
	}
	if pos == WatermarkTile {
		return []string{WatermarkTile}, true
	}
	seen := map[string]bool{}
	for _, c := range strings.Split(pos, ",") {
		if seen[c] || !slices.Contains(WatermarkPositions, c) {
			return nil, false
		}
		seen[c] = true
		cells = append(cells, c)
	}
	return cells, true
}

// ValidWatermarkPosition — см. WatermarkCells.
func ValidWatermarkPosition(pos string) bool {
	_, ok := WatermarkCells(pos)
	return ok
}

// FailFileTooLarge — код причины отказа для файла больше лимита на одно
// фото. Ставит API при подтверждении, до воркера (см. confirmOne): здесь,
// а не в imaging, потому что API собирается без cgo/libvips.
const FailFileTooLarge = "file_too_large"
