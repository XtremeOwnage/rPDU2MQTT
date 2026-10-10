---
title: Plan Storage
---

# Plan Storage

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

Where floor plan images are kept: a directory on a persistent volume, or an S3-compatible bucket. Never the configuration itself.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `PlanStorage` | object |  | Where floor plan images are kept: a directory on a persistent volume, or an S3-compatible bucket. Never the configuration itself. |
| `PlanStorage.Directory` | string |  | Directory floor plan images are written to. Put it on a persistent volume: a PVC on Kubernetes, a volume under Docker Compose, any directory for a plain binary. Blank uses 'plans' beside the program, which a container loses on restart. Ignored when an object store bucket is set. |
| `PlanStorage.MaxMegabytes` | int | `10` | Largest image accepted, in megabytes. A phone photo is shrunk in the browser before it is sent, so this is rarely reached. Range 1–100. |
| `PlanStorage.ObjectStore` | object |  | An S3-compatible object store (AWS S3, MinIO, Ceph, Garage, R2) to keep images in instead of a directory. |
| `PlanStorage.ObjectStore.Endpoint` | string |  | The store's endpoint, for example 'https://s3.us-east-1.amazonaws.com' or 'http://minio:9000'. |
| `PlanStorage.ObjectStore.Bucket` | string |  | The bucket images are kept in. Setting it switches plan storage from the directory to this store. |
| `PlanStorage.ObjectStore.Region` | string | `us-east-1` | The region requests are signed for. Most self-hosted stores accept 'us-east-1'. |
| `PlanStorage.ObjectStore.AccessKeyId` | string |  | Access key id. |
| `PlanStorage.ObjectStore.SecretAccessKey` | string (secret) |  | Secret access key. |
| `PlanStorage.ObjectStore.Prefix` | string | `floorplans/` | Prefix for every object this bridge writes, so it can share a bucket. |
| `PlanStorage.ObjectStore.PathStyle` | bool | `true` | Address the bucket as a path ('endpoint/bucket/key') rather than a subdomain. Self-hosted stores almost always need this on. |
