"use client";

import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { Component, Suspense, type ReactNode } from "react";

type ErrorFallback = ReactNode | ((retry: () => void) => ReactNode);

interface BoundaryProps {
  onReset: () => void;
  fallback: ErrorFallback;
  children: ReactNode;
}

class ErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  retry = () => {
    this.props.onReset();
    this.setState({ failed: false });
  };

  override render() {
    if (!this.state.failed) return this.props.children;
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
export function DataBoundary({ fallback, errorMessage = "Could not load this.", errorFallback = retryMessage(errorMessage), children }: {
  fallback: ReactNode;
  /** Text for the default "Try again" fallback. Ignored when errorFallback is set. */
  errorMessage?: string;
  errorFallback?: ErrorFallback;
  children: ReactNode;
}) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary onReset={reset} fallback={errorFallback}>
          <Suspense fallback={fallback}>{children}</Suspense>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
