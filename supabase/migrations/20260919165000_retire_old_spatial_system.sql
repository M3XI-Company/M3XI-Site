-- ===========================================================================
-- Retire the first World Viewer / Spatial attempt, in full.
--
-- Every one of these tables was empty (m3ix_events held 2 rows) so nothing of
-- value was lost. The replacement lives in the wv_ namespace and shares no
-- structure with this deliberately: the old model treated a world as a file
-- plus some hotspots, the new one treats it as a versioned spatial database
-- with provenance on every fact.
--
-- Non-spatial M3XI tables (waitlist, wallet, purchases, credits, videos, the
-- video worker queue, social posting) are untouched.
-- ===========================================================================

drop view if exists public.m3ix_tour_public cascade;

drop function if exists public.m3ix_library(integer) cascade;
drop function if exists public.m3ix_library() cascade;
drop function if exists public.m3ix_featured_world() cascade;
drop function if exists public.m3ix_is_org_member(uuid) cascade;
drop function if exists public.m3ix_has_world_access(uuid) cascade;
drop function if exists public.m3ix_capture_property(text) cascade;
drop function if exists public.m3ix_my_queue(integer) cascade;
drop function if exists public.m3ix_on_lead_insert() cascade;

drop table if exists public.m3ix_annotation cascade;
drop table if exists public.m3ix_node cascade;
drop table if exists public.m3ix_room cascade;
drop table if exists public.m3ix_tour cascade;
drop table if exists public.m3ix_build cascade;
drop table if exists public.m3ix_describe_input cascade;
drop table if exists public.m3ix_capture cascade;
drop table if exists public.m3ix_property cascade;
drop table if exists public.m3ix_org_member cascade;
drop table if exists public.m3ix_org cascade;
drop table if exists public.m3ix_hotspots cascade;
drop table if exists public.m3ix_likes cascade;
drop table if exists public.m3ix_events cascade;
drop table if exists public.m3ix_leads cascade;
drop table if exists public.m3ix_presets cascade;
drop table if exists public.m3ix_templates cascade;
drop table if exists public.m3ix_gen_jobs cascade;
drop table if exists public.m3ix_config cascade;
drop table if exists public.m3ix_site cascade;
drop table if exists public.m3ix_spaces cascade;
