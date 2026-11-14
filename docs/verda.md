# Verda setup

## Provisioned

- Project: `Junction26`
- Credit balance verified: €200 on 2026-11-14
- Object-storage bucket: `junction26-applets`
- Location: FIN-03
- S3 endpoint: `https://objects.eu-north-3.verda.storage`
- S3 signing region: `eu-north-3`
- Addressing: path-style
- Storage access-key name: `junction26-backend-storage`

Local credentials are in `.env.verda.local` with file mode `0600`. Git ignores
this file. `.env.verda.example` documents the variable names without secrets.
These credentials belong only in the backend and deployment secret storage;
never include them in frontend bundles or applet packages.

Bucket access and an upload/read/delete round trip were verified. The temporary
verification object was deleted.

## Application integration

Use object keys under these prefixes:

- `uploads/<user-id>/<upload-id>/original` for original user material.
- `assets/<sha256>.<ext>` for applet-specific prepared assets.
- `releases/<project-id>/<release-id>/package.json` for immutable published packages.
- `healthcheck/` for `npm run smoke:storage` (deleted after each run).

The layout is defined once in `packages/storage/src/keys.ts`.

Enforce ownership in the backend. Published packages should include their unique
assets, with shared components and standard assets shipped in the web app.
The glasses cache packages and execute locally; storage is used for initial
downloads, revisions, and explicit sync rather than ordinary interactions.

Use an S3 client configured with this endpoint, region, and path-style addressing.
Keep this integration behind a storage adapter so the provider can be replaced.

Platform limits (docs, updated 2026-10-16): Object Storage is **beta**; quota 1 TiB,
100,000 objects, 100 buckets. **No CORS, bucket policies, ACLs or public buckets**,
so browsers can't read or write objects directly, even with presigned URLs. The
API proxies all uploads and package downloads. Buckets can't be created through
the S3 API (console or Verda API only). Storage is billed per GiB-month from the
prepaid balance; requests and egress are free. **If the balance reaches zero, S3
access is suspended.**

## Remaining infrastructure

No compute instance or backend deployment has been provisioned. The backend
(`apps/api`, `apps/worker`) exists and uses this bucket through
`packages/storage`; the adapter passed a live round trip on 2026-11-14. No Aiven database has been set up.
The selected application host is now Aiven Runtime, with Aiven PostgreSQL for
structured persistence. Verda is used for object storage; no Verda CPU host is
required by the current plan. See [Backend architecture](backend-architecture.md).

Verda advertises FIN-03 storage maintenance on 2026-11-15 from 19:00 to 22:00 UTC,
with possible brief storage interruptions. Cached applets should remain usable
without storage access. Verify future maintenance notices in the console.
