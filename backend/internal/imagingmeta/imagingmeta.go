// Package imagingmeta — константы пайплайна изображений, безопасные для
// импорта без CGO (api-бинарник не должен линковаться с libvips).
package imagingmeta

import "strconv"

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
