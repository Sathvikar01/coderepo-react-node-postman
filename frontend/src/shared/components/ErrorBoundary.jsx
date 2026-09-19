import { Component } from "react";
import { MaterialIcon } from "./MaterialIcon.jsx";

export class ErrorBoundary extends Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}

	static getDerivedStateFromError(error) {
		return { error };
	}

	componentDidCatch(error, info) {
		console.error("Workspace render failed", error, info?.componentStack);
	}

	render() {
		if (!this.state.error) return this.props.children;
		return (
			<main aria-label="Workspace error" className="workspace-empty" role="alert">
				<span className="empty-illustration danger">
					<MaterialIcon size={30}>error</MaterialIcon>
				</span>
				<h2>Something in this view failed to render</h2>
				<p>Your saved collections, environments, and history are unaffected. Reload to continue where you left off.</p>
				<div>
					<button className="primary-button" type="button" onClick={() => window.location.reload()}>
						Reload the workspace
					</button>
					<button className="text-button" type="button" onClick={() => this.setState({ error: null })}>
						Try again
					</button>
				</div>
			</main>
		);
	}
}
