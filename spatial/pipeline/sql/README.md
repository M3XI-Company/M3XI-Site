The queue functions (`wv_claim_job`, `wv_heartbeat_job`, `wv_reap_expired_jobs`)
are a migration, not a loose script: see

    supabase/migrations/20260919171000_world_viewer_queue.sql

They are versioned alongside `worldengine/worker.py`, because changing either
one without the other silently changes leasing behaviour. The earlier
three-argument `wv_claim_job` was dropped rather than left as an overload —
two callers resolving to different overloads is exactly the drift this warns
about.

The worker no longer calls these functions. They are `service_role`-only by
design, and a rented GPU pod must not hold a service-role key, so the pod now
talks to `supabase/functions/wv-jobs` over HTTPS with a shared secret and the
edge function makes these calls on its behalf. See the worker's module
docstring and the "What the pod is trusted with" section of ../README.md.

That means the grants at the bottom of the migration are load bearing: if
`wv_claim_job` were ever granted to `authenticated` or `anon`, the shared-secret
check in wv-jobs would become decorative, because the anon key is printed in
every page of the site.
