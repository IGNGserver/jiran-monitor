// Minimal JSON decode/aggregate/encode experiment, NOT a Hub implementation.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strconv"
	"time"
)

type Period struct {
	TotalTokens int64            `json:"totalTokens"`
	CostUSD     float64          `json:"costUsd"`
	Clients     map[string]int64 `json:"clients"`
	Models      map[string]int64 `json:"models"`
}
type Record struct {
	Today   Period `json:"today"`
	Month   Period `json:"month"`
	AllTime Period `json:"allTime"`
}
type Summary struct {
	TotalTokens int64            `json:"totalTokens"`
	CostUSD     float64          `json:"costUsd"`
	Clients     map[string]int64 `json:"clients"`
	Models      map[string]int64 `json:"models"`
}

func aggregate(records []Record) map[string]*Summary {
	result := map[string]*Summary{}
	for _, name := range []string{"today", "month", "allTime"} {
		result[name] = &Summary{Clients: map[string]int64{}, Models: map[string]int64{}}
	}
	for _, record := range records {
		for name, period := range map[string]Period{"today": record.Today, "month": record.Month, "allTime": record.AllTime} {
			out := result[name]
			out.TotalTokens += period.TotalTokens
			out.CostUSD += period.CostUSD
			for key, value := range period.Clients {
				out.Clients[key] += value
			}
			for key, value := range period.Models {
				out.Models[key] += value
			}
		}
	}
	return result
}

func main() {
	if len(os.Args) != 3 {
		panic("usage: aggregate fixture.json iterations")
	}
	input, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	iterations, err := strconv.Atoi(os.Args[2])
	if err != nil || iterations < 1 || iterations > 10000 {
		panic("invalid iterations")
	}
	var final map[string]*Summary
	run := func() {
		var records []Record
		if err := json.Unmarshal(input, &records); err != nil {
			panic(err)
		}
		final = aggregate(records)
		if _, err := json.Marshal(final); err != nil {
			panic(err)
		}
	}
	for i := 0; i < 5; i++ {
		run()
	}
	samples := make([]float64, iterations)
	start := time.Now()
	for i := range samples {
		before := time.Now()
		run()
		samples[i] = float64(time.Since(before).Nanoseconds()) / 1e6
	}
	elapsed := float64(time.Since(start).Nanoseconds()) / 1e6
	sort.Float64s(samples)
	output := map[string]any{"runtime": runtime.Version(), "iterations": iterations, "elapsedMs": elapsed, "sortedSamplesMs": samples, "summary": final,
		"scope": "JSON decode of typed known fields (unknown sessions/history scanned but not materialized), primitive totals/client/model aggregation, JSON encode; no HTTP, SSE, auth, storage or production Hub logic"}
	encoded, err := json.Marshal(output)
	if err != nil {
		panic(err)
	}
	fmt.Println(string(encoded))
}
