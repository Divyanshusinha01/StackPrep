package inventory

import (
	"encoding/json"
	"net/http"
)

type reserveRequest struct {
	SKU      string `json:"sku"`
	Quantity int    `json:"quantity"`
}

// ReserveHandler exposes Store.Reserve as POST /reserve.
func ReserveHandler(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req reserveRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Quantity <= 0 {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		if err := store.Reserve(req.SKU, req.Quantity); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
