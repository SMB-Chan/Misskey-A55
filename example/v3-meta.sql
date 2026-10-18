-- Apply once against the misskey database after deploying a55v3.
-- All flags are admin-reversible. Schema is unchanged.
-- Charts and URL preview are local UX/CPU, not ActivityPub protocol.

update meta set
  "enableChartsForRemoteUser" = false,
  "enableChartsForFederatedInstances" = false,
  "enableStatsForFederatedInstances" = false,
  "enableIdenticonGeneration" = false,
  "urlPreviewEnabled" = false;
