import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./App";
import { GeneratePage } from "./pages/GeneratePage";
import { HistoryPage } from "./pages/HistoryPage";
import { StickerDetailPage } from "./pages/StickerDetailPage";
import "./styles.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <GeneratePage /> },
      { path: "history", element: <HistoryPage /> },
      { path: "stickers/:id", element: <StickerDetailPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
