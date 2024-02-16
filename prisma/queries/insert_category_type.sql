INSERT INTO "CategoryType" (name, places, lowercase, compare)
VALUES
    ('brand', ARRAY['brand'], false, 'INCLUDES'),
    ('word', ARRAY['title', 'description'], true, 'INCLUDES'),
    ('country', ARRAY['countryCode'], false, 'EQUAL');
