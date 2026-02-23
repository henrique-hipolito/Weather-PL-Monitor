-- ============================================================================
-- Seed: 12 monitored cities
-- Idempotent — safe to re-run
-- ============================================================================

INSERT INTO cities (city_id, name, country_code, timezone, lat, lon, slug_name) VALUES
  -- US cities (°F, NOAA/NWS)
  ('nyc_us',          'New York City', 'US', 'America/New_York',               40.712800,  -74.006000, 'nyc'),
  ('atlanta_us',      'Atlanta',       'US', 'America/New_York',               33.749000,  -84.388000, 'atlanta'),
  ('chicago_us',      'Chicago',       'US', 'America/Chicago',                41.878100,  -87.629800, 'chicago'),
  ('miami_us',        'Miami',         'US', 'America/New_York',               25.761700,  -80.191800, 'miami'),
  ('seattle_us',      'Seattle',       'US', 'America/Los_Angeles',            47.606200, -122.332100, 'seattle'),
  ('dallas_us',       'Dallas',        'US', 'America/Chicago',                32.776700,  -96.797000, 'dallas'),
  -- International cities (°C, Open-Meteo)
  ('buenosaires_ar',  'Buenos Aires',  'AR', 'America/Argentina/Buenos_Aires',-34.603700,  -58.381600, 'buenos-aires'),
  ('seoul_kr',        'Seoul',         'KR', 'Asia/Seoul',                     37.566500,  126.978000, 'seoul'),
  ('london_gb',       'London',        'GB', 'Europe/London',                  51.507400,   -0.127800, 'london'),
  ('saopaulo_br',     'São Paulo',     'BR', 'America/Sao_Paulo',            -23.550500,  -46.633300, 'sao-paulo'),
  ('wellington_nz',   'Wellington',    'NZ', 'Pacific/Auckland',             -41.286500,  174.776200, 'wellington'),
  ('toronto_ca',      'Toronto',       'CA', 'America/Toronto',               43.653200,  -79.383200, 'toronto')
ON CONFLICT (city_id) DO NOTHING;
