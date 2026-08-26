import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary glass-card">
        <h2>{this.props.title || "Something broke in this view"}</h2>
        <p>{String(this.state.error.message || this.state.error)}</p>
        <button type="button" className="run-btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
