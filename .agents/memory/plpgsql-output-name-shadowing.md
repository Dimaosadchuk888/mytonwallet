---
name: PL/pgSQL output-name shadowing
description: Avoid ambiguous column references in functions that declare table-shaped output fields.
---

In a PL/pgSQL function using `RETURNS TABLE`, each output field name also behaves like a local variable. Qualify table columns with an alias in SQL statements when a column shares an output name.

**Why:** PostgreSQL can accept the function definition but fail only at runtime with an ambiguous-column error, causing the surrounding transaction to roll back.

**How to apply:** In balance and ledger RPCs, alias target tables and qualify fields in expressions and `RETURNING` clauses; exercise the real RPC after applying migrations.