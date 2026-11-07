-- Counts of the catalogue by source, the same query on the Mac and on the server (docs/deployment.md, «Перенос бази»):
-- one tab-separated line per number, sorted, so the outputs of two databases compare with diff. Reads only.
select line from (
  select format(E'models\t%s\tactive=%s\tall=%s', s.code, count(*) filter (where m.is_active), count(*)) as line
    from source s join product_model m on m.source_id = s.id group by s.code
  union all
  select format(E'photos\t%s\tactive=%s\tall=%s', s.code, count(*) filter (where p.is_active), count(*))
    from source s join product_model m on m.source_id = s.id join photo p on p.model_id = m.id group by s.code
  union all
  select format(E'photo_vectors\t%s\t%s\t%s', s.code, e.embedding_model, count(*))
    from source s join product_model m on m.source_id = s.id join photo p on p.model_id = m.id
    join photo_embedding e on e.photo_id = p.id group by s.code, e.embedding_model
  union all
  select format(E'text_vectors\t%s\t%s\t%s', s.code, e.embedding_model, count(*))
    from source s join product_model m on m.source_id = s.id join text_embedding e on e.model_id = m.id
    group by s.code, e.embedding_model
  union all
  select format(E'rows\t%s\t%s', t.name, t.n) from (values
    ('variant', (select count(*) from variant)),
    ('price', (select count(*) from price)),
    ('stock', (select count(*) from stock)),
    ('category', (select count(*) from category)),
    ('source_category', (select count(*) from source_category)),
    ('own_product', (select count(*) from own_product)),
    ('own_product_link', (select count(*) from own_product_link)),
    ('query_reading', (select count(*) from query_reading)),
    ('app_user', (select count(*) from app_user)),
    ('user_session', (select count(*) from user_session)),
    ('user_invite', (select count(*) from user_invite)),
    ('result_grade', (select count(*) from result_grade))
  ) as t (name, n)
  union all
  select format(E'migrations\t%s\t%s', count(*), max(migration_name)) from _prisma_migrations
    where finished_at is not null and rolled_back_at is null
) as lines
order by line;
