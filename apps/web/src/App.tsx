import { NavLink, Outlet } from "react-router-dom";

export function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Internal Tool</p>
          <h1>Sticker Generator</h1>
        </div>
        <nav>
          <NavLink to="/">Generate</NavLink>
          <NavLink to="/history">History</NavLink>
        </nav>
      </header>
      <Outlet />
    </main>
  );
}
