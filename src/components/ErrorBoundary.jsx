import { Component } from "react";
import { LangContext, translate } from "../i18n/langStore";

export default class ErrorBoundary extends Component {
  // Class components can't call useI18n(); contextType gives render()
  // access to the same language context so the crash screen isn't the one
  // English-only view in an otherwise bilingual app.
  static contextType = LangContext;

  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    const lang = this.context?.lang || "en";
    return (
      <div className="error-boundary glass-card">
        <h2>{this.props.title || translate(lang, "error.title")}</h2>
        <p>{String(this.state.error.message || this.state.error)}</p>
        <button type="button" className="run-btn" onClick={() => this.setState({ error: null })}>
          {translate(lang, "error.retry")}
        </button>
      </div>
    );
  }
}
