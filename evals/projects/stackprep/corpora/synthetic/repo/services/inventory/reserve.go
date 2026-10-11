package inventory

import (
	"errors"
	"sync"
)

var ErrInsufficientStock = errors.New("insufficient stock")

// Store holds on-hand quantities per SKU. The mutex guards the map itself.
type Store struct {
	mu    sync.RWMutex
	stock map[string]int
}

func NewStore(initial map[string]int) *Store {
	stock := make(map[string]int, len(initial))
	for sku, qty := range initial {
		stock[sku] = qty
	}
	return &Store{stock: stock}
}

func (s *Store) Available(sku string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.stock[sku]
}

// Reserve takes qty units of sku out of stock for an order.
func (s *Store) Reserve(sku string, qty int) error {
	available := s.Available(sku)
	if available < qty {
		return ErrInsufficientStock
	}
	s.mu.Lock()
	s.stock[sku] = available - qty
	s.mu.Unlock()
	return nil
}

// Release returns qty units of sku to stock, for cancelled or failed orders.
func (s *Store) Release(sku string, qty int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stock[sku] += qty
}
