-- check the matches first: SELECT id, title FROM "LibraryBook" WHERE title ILIKE '86%' OR title ILIKE '%Frieren%';
UPDATE "LibraryBook" SET series = '86' WHERE title ILIKE '86%';
UPDATE "LibraryBook" SET series = 'Frieren' WHERE title ILIKE '%Frieren%';
