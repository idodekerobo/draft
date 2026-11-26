-- pi stores each record as exact JSON text. jsonb rejects a NUL character and a lone surrogate that json keeps, and
-- nothing queries inside a record, so these two columns are json.
alter table embedded_agent_records alter column record type json using record::json;
alter table embedded_agent_documents alter column record type json using record::json;
