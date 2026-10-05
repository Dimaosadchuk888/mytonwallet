---
name: PL/pgSQL output-name shadowing
description: Avoid ambiguous column references in functions that declare table-shaped output fields.
---

In a PL/pgSQL function using `RETURNS TABLE`, each output field name also behaves like a local variable. Qualify table columns with an alias in SQL statements when a column shares an output name.

**Why:** PostgreSQL can accept the function definition but fail only at runtime with an ambiguous-column error, causing the surrounding transaction to roll back. JavaScript server tests also do not parse PL/pgSQL and can miss SQL keyword conflicts entirely.

**How to apply:** In balance and ledger RPCs, alias target tables and qualify fields in expressions and `RETURNING` clauses. Before handing production SQL to the user, apply the exact migration and exercise representative RPCs in an isolated PostgreSQL instance, including a repeat migration run; do not rely only on server tests.