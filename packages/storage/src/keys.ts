/**
 * The single source of object key layout. Keys are deterministic so a retried
 * job overwrites the same object instead of creating duplicates.
 */
export const objectKeys = {
  upload: (userId: string, uploadId: string) => `uploads/${userId}/${uploadId}/original`,
  asset: (sha256: string, ext: string) => `assets/${sha256}.${ext}`,
  releasePackage: (projectId: string, releaseId: string) => `releases/${projectId}/${releaseId}/package.json`,
};
