// Trace helper class
class QueryTrace {
  constructor(enabled = false) {
    this.enabled = enabled;
    this.steps = [];
    this.startTime = Date.now();
  }

  addStep(name, description, result = null, status = 'success') {
    if (!this.enabled) return;
    this.steps.push({
      name,
      description,
      result,
      status,
      timestamp: Date.now(),
      duration_ms: this.steps.length > 0
        ? Date.now() - this.steps[this.steps.length - 1].timestamp
        : Date.now() - this.startTime
    });
  }

  getTrace() {
    if (!this.enabled) return null;
    return {
      steps: this.steps,
      total_duration_ms: Date.now() - this.startTime
    };
  }
}

export { QueryTrace };
