// Package imagingmeta — константы пайплайна изображений, безопасные для
// импорта без CGO (api-бинарник не должен линковаться с libvips).
package imagingmeta

// DerivativeSizes — деривативы (longest side, px). Покупателю уходят только они.
var DerivativeSizes = []int{300, 800, 1600}
