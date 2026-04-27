// Vite entry. Wraps the App in StarknetConfig so all child components can
// hook into the Cartridge Controller via @starknet-react/core.

import React from "react";
import ReactDOM from "react-dom/client";
import { StarknetConfig, jsonRpcProvider, voyager } from "@starknet-react/core";
import { sepolia } from "@starknet-react/chains";

import { cartridgeConnector } from "./cartridgeConnector";
import { NFT_NETWORK } from "./networkConfig";
import App from "./App";
import "./style.css";

ReactDOM.createRoot(document.getElementById("app")!).render(
  <React.StrictMode>
    <StarknetConfig
      autoConnect
      chains={[sepolia]}
      connectors={[cartridgeConnector]}
      defaultChainId={sepolia.id}
      explorer={voyager}
      provider={jsonRpcProvider({ rpc: () => ({ nodeUrl: NFT_NETWORK.rpcUrl }) })}
    >
      <App />
    </StarknetConfig>
  </React.StrictMode>,
);
