# Guild gallery

The gallery lives inside the signed-in guildhall. Current Battle.net-verified members can share JPEG, PNG or WebP screenshots with a title and optional caption, browse the newest images, and open a larger view. The author name uses their linked Discord display name when available, otherwise their current guild character.

Members can remove and restore their own uploads. The configured administrator can moderate all uploads. Removal is reversible: the record remains in the Removed view but its image routes return 404 until restored. A member who leaves the guild loses gallery access with the rest of the private dashboard. Existing uploads remain available to the guild until removed.

## Image handling

The browser decodes and resizes each image to a maximum of 1,600 pixels per side, re-encodes it as JPEG, and creates a thumbnail of up to 400 pixels per side. Files are limited to 12 MB before conversion, 750 KB for the shared image and 60 KB for the thumbnail. Oversized dimensions and unsupported formats are rejected. The server validates JPEG framing and dimensions and strips application metadata and comments. Original camera, GPS and filename metadata are not retained. Captions can still reveal personal information, so members should check what they share.

Images and thumbnails are served through member-gated routes with private, non-cacheable responses. No public bucket or external image URL is created. Gallery uploads do not trigger Discord messages.

## Storage and limits

The first version uses the existing database on both Cloudflare and Docker; it requires no additional storage account or service. The `0021_gallery.sql` migration adds `gallery_photos`. Back up this table with the rest of the private guild database.

The gallery allows 10 uploads per member per UTC calendar day, a maximum of 200 stored photos and 100 MB of combined image and thumbnail bytes. Removed photos count toward these limits because their files are retained for restoration. Quotas are checked in the same database statement as the insert, preventing simultaneous uploads from exceeding them.

These limits are intentionally modest for the existing hosting setup. A larger gallery should move its image bytes into private object storage while retaining database metadata, authentication and moderation. Cloudflare documents the supported binary bindings and database size limits in its [D1 API reference](https://developers.cloudflare.com/d1/worker-api/) and [platform limits](https://developers.cloudflare.com/d1/platform/limits/).

Deploy the migration before publishing the Worker. The Cloudflare deployment script applies pending migrations; Docker applies them at startup. The self-hosted HTTP server allows the larger upload body only on the gallery upload route and retains the existing limits for other forms.
