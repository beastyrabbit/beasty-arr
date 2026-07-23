// Global test guard: live AI calls are forbidden in automated tests.
// Any code path that would reach a real provider must be injected with a mock;
// this makes an accidental live call fail loudly instead of costing money.
process.env.BEASTY_ARR_FORBID_LIVE_AI = "1";
process.env.NODE_ENV = "test";
