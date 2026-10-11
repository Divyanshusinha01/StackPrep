# Tidepool

Tidepool is a small storefront backend: customer sessions, orders, card payments through a payment
gateway, an inventory service written in Go, a Python email worker, and a CSV report exporter in Java.

## Layout

- `src/` Node HTTP API (TypeScript)
  - `auth/` password hashing and sessions
  - `middleware/` rate limiting and CSRF protection
  - `orders/` order validation and the order service
  - `payments/` card charges and gateway webhooks
  - `db/` database client and repositories
  - `cache/` in-process LRU cache
- `services/inventory/` stock reservations (Go)
- `workers/` email delivery worker (Python)
- `reports/` order report exporter (Java)
- `web/` storefront React components

## Running

```sh
npm install
npm run dev
```
