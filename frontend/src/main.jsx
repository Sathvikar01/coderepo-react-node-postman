import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import App from "./features/ui-exact/App.jsx";
import { ErrorBoundary } from "./shared/components/ErrorBoundary.jsx";
import "./styles.css";
import "./phase30-workbench.css";
import "./features/ui-exact/exact.css";

createRoot(document.getElementById("root")).render(
	<StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
);
