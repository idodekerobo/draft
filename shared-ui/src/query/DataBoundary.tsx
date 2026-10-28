"use client";

import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { Component, Suspense, type ReactNode } from "react";

type ErrorFallback = ReactNode | ((retry: () => void) => ReactNode);

interface BoundaryProps {
  onReset: () => void;
  fallback: ErrorFallback;
  renderError?: (error: unknown) => ReactNode;
  children: ReactNode;
}

class ErrorBoundary extends Component<BoundaryProps, { failed: boolean; error: unknown }> {
  override state = { failed: false, error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  retry = () => {
    this.props.onReset();
    this.setState({ failed: false, error: null });
  };

  override render() {
    if (!this.state.failed) return this.props.children;
    const special = this.props.renderError?.(this.state.error);
    if (special) return special;
    const { fallback } = this.props;
    return typeof fallback === "function" ? fallback(this.retry) : fallback;
  }
}

const retryMessage = (message: string) => (retry: () => void) => (
  <p className="ui-error" role="alert">
    {message} <button type="button" className="ui-link" onClick={retry}>Try again</button>
  </p>
);

/** Loading and error boundary for anything that reads a suspense query. */
export function DataBoundary({ fallback, errorMessage = "Could not load this.", errorFallback = retryMessage(errorMessage), renderError, children }: {
  fallback: ReactNode;
  /** Text for the default "Try again" fallback. Ignored when errorFallback is set. */
  errorMessage?: string;
  errorFallback?: ErrorFallback;
  /** Shown instead of the fallback when it returns something, for an error that needs its own screen. */
  renderError?: (error: unknown) => ReactNode;
  children: ReactNode;
}) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary onReset={reset} fallback={errorFallback} renderError={renderError}>
          <Suspense fallback={fallback}>{children}</Suspense>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
