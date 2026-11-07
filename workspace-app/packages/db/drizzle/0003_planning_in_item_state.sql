-- Eén plek voor de planning: item_state (plan_date, backlog, moved; zie 0002). De tabel planning werd nergens
-- gebruikt en had geen rijen; PUT /api/itemstate/:key schrijft de planning.

DROP TABLE "planning" CASCADE;
