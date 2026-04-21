-- Aligns three demo web orders with data/stock.json in this repo (inventory snapshot + reservations).
-- Run in Supabase SQL Editor after deploying the updated stock.json to your server filesystem.
--
-- Orders (fixed order_ref, safe to re-run):
--   SAI-INV-DEMO-SHIPPED — paid + shipped: Standard Medium 10 cases + 100 boxes (already deducted from on_hand in stock.json).
--   SAI-INV-DEMO-PAID-1   — paid, not shipped: Standard Small 2 cases + 20 boxes (matches reserved on stock lines).
--   SAI-INV-DEMO-PAID-2   — paid, not shipped: General Medium 1 case + 15 boxes (matches reserved on stock lines).
--
-- If you already have rows with these order_ref values, they are deleted first.

begin;

delete from public.orders
where order_ref in ('SAI-INV-DEMO-SHIPPED', 'SAI-INV-DEMO-PAID-1', 'SAI-INV-DEMO-PAID-2');

insert into public.orders (
  order_ref,
  status,
  order_status,
  order_source,
  order_type,
  customer_name,
  customer_email,
  customer_phone,
  items,
  subtotal_cents,
  shipping_cents,
  tax_cents,
  total_cents,
  state,
  amount,
  tax_collected,
  provider,
  updated_at
)
values
  (
    'SAI-INV-DEMO-SHIPPED',
    'paid',
    'shipped',
    'web',
    'online',
    'Demo Customer (shipped)',
    'demo-shipped@example.com',
    '6155550100',
    $items1$[
      {
        "slug": "nitrile-standard",
        "name": "Nitrile Examination – Standard",
        "shortName": "Standard Series",
        "quantities": { "Small": 0, "Medium": 10, "Large": 0, "X Large": 0 },
        "boxQuantities": { "Small": 0, "Medium": 100, "Large": 0, "X Large": 0 },
        "bundleLines": []
      }
    ]$items1$::jsonb,
    100000,
    0,
    0,
    100000,
    'TN',
    100000,
    0,
    'square',
    now()
  ),
  (
    'SAI-INV-DEMO-PAID-1',
    'paid',
    'ready_to_ship',
    'web',
    'online',
    'Demo Customer (open 1)',
    'demo-open1@example.com',
    '6155550101',
    $items2$[
      {
        "slug": "nitrile-standard",
        "name": "Nitrile Examination – Standard",
        "shortName": "Standard Series",
        "quantities": { "Small": 2, "Medium": 0, "Large": 0, "X Large": 0 },
        "boxQuantities": { "Small": 20, "Medium": 0, "Large": 0, "X Large": 0 },
        "bundleLines": []
      }
    ]$items2$::jsonb,
    50000,
    0,
    0,
    50000,
    'TN',
    50000,
    0,
    'square',
    now()
  ),
  (
    'SAI-INV-DEMO-PAID-2',
    'paid',
    'ready_to_ship',
    'web',
    'online',
    'Demo Customer (open 2)',
    'demo-open2@example.com',
    '6155550102',
    $items3$[
      {
        "slug": "black-nitrile-general",
        "name": "Black Nitrile – General",
        "shortName": "General Purpose",
        "quantities": { "Small": 0, "Medium": 1, "Large": 0, "X Large": 0 },
        "boxQuantities": { "Small": 0, "Medium": 15, "Large": 0, "X Large": 0 },
        "bundleLines": []
      }
    ]$items3$::jsonb,
    40000,
    0,
    0,
    40000,
    'TN',
    40000,
    0,
    'square',
    now()
  );

commit;
