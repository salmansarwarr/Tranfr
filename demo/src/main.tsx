import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ccc } from "@ckb-ccc/connector-react";
import { App } from "./App";
import { client } from "./chain";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ccc.Provider name="Tranfr Demo" defaultClient={client}>
      <App />
    </ccc.Provider>
  </StrictMode>,
);
