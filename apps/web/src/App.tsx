import { NavLink, Outlet, useLocation } from "react-router-dom";

export function App() {
  const location = useLocation();
  const isGeneratorPage = location.pathname === "/";

  return (
    <div className="app-shell">
      {!isGeneratorPage ? (
        <header className="app-header">
          <div>
            <p className="eyebrow">Internal Tool</p>
            <h1>Ding Ding Cat Sticker Generator</h1>
          </div>
          <nav>
            <NavLink to="/">Generate</NavLink>
            <NavLink to="/history">History</NavLink>
          </nav>
        </header>
      ) : null}
      <Outlet />
    </div>
  );
}
