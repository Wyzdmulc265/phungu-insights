# MSE Data API — API Documentation

**Base URL:** `https://kestrel-ed63dc1c.base44.app/functions`

**Authentication:** All data endpoints require an API key passed in the `x-api-key` header.

**Data formats:** JSON (default) and CSV (export endpoint).

---

## Table of Contents

1. [Authentication](#authentication)
2. [Get Latest Stock Prices](#1-get-latest-stock-prices)
3. [Get Stock Price History](#2-get-stock-price-history)
4. [Export to CSV/JSON](#3-export-to-csvjson)
5. [Data Schema](#data-schema)
6. [Rate Limits & Usage Tracking](#rate-limits--usage-tracking)
7. [Code Examples](#code-examples)
8. [Error Handling](#error-handling)

---

## Authentication

Every request must include your API key in the `x-api-key` header:

```
x-api-key: mse_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

API keys are managed by the system administrator. Contact them to get a key.

---

## 1. Get Latest Stock Prices

Returns the most recent price snapshot for each stock, optionally filtered by market type or symbol.

### Request

```
GET /functions/getMseStocks
```

### Query Parameters

| Parameter     | Type   | Required | Description                                      |
|---------------|--------|----------|--------------------------------------------------|
| `market_type` | string | No       | `mainboard`, `debt`, or `edgex`                   |
| `symbol`      | string | No       | Filter to a specific stock symbol (e.g. `NICO`)   |
| `limit`       | int    | No       | Max results (default: 100)                        |

### Example

```
GET /functions/getMseStocks?market_type=mainboard
```

### Response (200 OK)

```json
{
  "count": 16,
  "trade_date": "2026-08-04",
  "data": [
    {
      "symbol": "NICO",
      "market_type": "mainboard",
      "trade_date": "2026-08-04",
      "open_price": 1347.97,
      "close_price": 1347.92,
      "change_percent": 0,
      "volume": 4432,
      "turnover": 5974018.00,
      "interest": 0
    }
  ]
}
```

---

## 2. Get Stock Price History

Returns historical price records for a specific stock, optionally filtered by date range.

### Request

```
GET /functions/getMseStockHistory
```

### Query Parameters

| Parameter     | Type   | Required | Description                                          |
|---------------|--------|----------|------------------------------------------------------|
| `symbol`      | string | **Yes**  | Stock symbol (e.g. `NICO`, `AIRTEL`, `NBM`)          |
| `market_type` | string | No       | `mainboard`, `debt`, or `edgex`                       |
| `from_date`   | string | No       | Start date (YYYY-MM-DD)                               |
| `to_date`     | string | No       | End date (YYYY-MM-DD)                                 |
| `limit`       | int    | No       | Max results (default: 500)                            |

### Example

```
GET /functions/getMseStockHistory?symbol=NICO&from_date=2026-08-01&to_date=2026-08-04
```

### Response (200 OK)

```json
{
  "symbol": "NICO",
  "count": 4,
  "from_date": "2026-08-01",
  "to_date": "2026-08-04",
  "data": [
    {
      "symbol": "NICO",
      "market_type": "mainboard",
      "trade_date": "2026-08-04",
      "open_price": 1347.97,
      "close_price": 1347.92,
      "change_percent": 0,
      "volume": 4432,
      "turnover": 5974018.00,
      "interest": 0
    }
  ]
}
```

---

## 3. Export to CSV/JSON

Downloads stock data as a CSV file attachment or JSON response, optionally filtered.

### Request

```
GET /functions/exportMseExcel
```

### Query Parameters

| Parameter     | Type   | Required | Description                                      |
|---------------|--------|----------|--------------------------------------------------|
| `market_type` | string | No       | `mainboard`, `debt`, or `edgex`                   |
| `symbol`      | string | No       | Filter to a specific stock symbol                 |
| `trade_date`  | string | No       | Filter to a specific date (YYYY-MM-DD)            |
| `format`      | string | No       | `csv` (default) or `json`                          |

### Example

```
GET /functions/exportMseExcel?market_type=mainboard&format=csv
GET /functions/exportMseExcel?symbol=NICO&format=json
```

### Response (CSV)

Returns a `text/csv` file download with headers:

```
symbol,market_type,trade_date,open_price,close_price,change_percent,volume,turnover,interest
NICO,mainboard,2026-08-04,1347.97,1347.92,0,4432,5974018,0
NBM,mainboard,2026-08-04,9548.83,9548.81,0,212,2024349,0
...
```

---

## Data Schema

Each stock price record contains:

| Field             | Type    | Description                                         |
|-------------------|---------|-----------------------------------------------------|
| `symbol`          | string  | Stock ticker symbol (e.g. `NICO`, `AIRTEL`)         |
| `market_type`     | string  | Market board: `mainboard`, `debt`, or `edgex`       |
| `trade_date`      | string  | Trading date (YYYY-MM-DD)                           |
| `open_price`      | number  | Opening price in Malawi Kwacha (MK)                 |
| `close_price`     | number  | Closing price in Malawi Kwacha (MK)                 |
| `change_percent`  | number  | Percentage change from previous close               |
| `volume`          | number  | Number of shares traded                             |
| `turnover`        | number  | Total value of shares traded (MK)                   |
| `interest`        | number  | Interest rate (debt securities only, 0 for equities) |

---

## Rate Limits & Usage Tracking

- No hard rate limit is enforced currently.
- Each API key's usage is tracked automatically:
  - `requests_count` — total API calls made
  - `last_used` — timestamp of most recent call
- Contact the administrator to check usage stats or deactivate a key.

---

## Code Examples

### JavaScript / Node.js

```javascript
const API_KEY = "mse_xxx...";
const BASE_URL = "https://kestrel-ed63dc1c.base44.app/functions";

// Get latest mainboard stocks
const res = await fetch(`${BASE_URL}/getMseStocks?market_type=mainboard`, {
  headers: { "x-api-key": API_KEY }
});
const { data } = await res.json();
console.log(data);
```

### Python

```python
import requests

API_KEY = "mse_xxx..."
BASE_URL = "https://kestrel-ed63dc1c.base44.app/functions"

# Get NICO price history
res = requests.get(
    f"{BASE_URL}/getMseStockHistory",
    params={"symbol": "NICO", "from_date": "2026-08-01"},
    headers={"x-api-key": API_KEY}
)
data = res.json()
print(data)
```

### cURL

```bash
# Get all latest stocks
curl -s "https://kestrel-ed63dc1c.base44.app/functions/getMseStocks" \
  -H "x-api-key: mse_xxx..."

# Export to CSV
curl -s -o mse_data.csv \
  "https://kestrel-ed63dc1c.base44.app/functions/exportMseExcel?market_type=mainboard&format=csv" \
  -H "x-api-key: mse_xxx..."

# Get stock history
curl -s "https://kestrel-ed63dc1c.base44.app/functions/getMseStockHistory?symbol=NICO" \
  -H "x-api-key: mse_xxx..."
```

### PHP

```php
$apiKey = "mse_xxx...";
$url = "https://kestrel-ed63dc1c.base44.app/functions/getMseStocks?market_type=mainboard";

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ["x-api-key: $apiKey"]);
$response = curl_exec($ch);
curl_close($ch);

$data = json_decode($response, true);
print_r($data);
```

---

## Error Handling

### 401 Unauthorized

```json
{ "error": "Missing API key. Provide it in the 'x-api-key' header." }
{ "error": "Invalid or inactive API key" }
```

### 400 Bad Request

```json
{ "error": "symbol is required. Example: ?symbol=AIRTEL&from_date=2026-08-01&to_date=2026-08-04" }
```

### 404 Not Found

```json
{ "error": "No data found for the given filters" }
```

### 500 Internal Server Error

```json
{ "error": "Failed to fetch stock data: <details>" }
```

---

## Support

- **API issues:** Contact the system administrator
- **Data source:** Malawi Stock Exchange (mse.co.mw)
- **Data freshness:** Updated 3x daily on trading days (11:00, 13:00, 15:00 CAT)
