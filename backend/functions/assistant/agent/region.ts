// Imported first, before any AWS client is created: the SDK reads the region
// once, at construction. AgentCore sets AWS_REGION in the runtime; this only
// covers a local run without it.
process.env.AWS_REGION ??= process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
