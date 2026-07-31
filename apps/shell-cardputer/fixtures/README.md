# Core protocol fixtures

`apps-50.json` is a 111367-byte representative `GET /api/apps`
response with 50 apps. It includes a 3,000-byte ignored description, nested optional
fields, unknown runtime/operation states, routine and review-required updates, nulls,
and Unicode. Host tests feed it in chunk sizes from one byte to 1,024 bytes to
exercise response-boundary independence.

