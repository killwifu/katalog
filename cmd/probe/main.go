package main

import (
	"fmt"
	"os"

	"github.com/davidbyttow/govips/v2/vips"

	"katalog/backend/internal/imaging"
)

func main() {
	vips.Startup(nil)
	defer vips.Shutdown()
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	res, err := imaging.Process(data)
	if err != nil {
		fmt.Println("ERROR:", err)
		os.Exit(1)
	}
	fmt.Printf("OK %dx%d phash=%d sizes=%d/%d/%d\n", res.Width, res.Height, res.PHash,
		len(res.Derivatives[300]), len(res.Derivatives[800]), len(res.Derivatives[1600]))
}
