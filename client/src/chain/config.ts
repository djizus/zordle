function required(name: string): string {
  const v = import.meta.env[name];
  if (!v) {
    throw new Error(`Missing env: ${name}`);
  }
  return v as string;
}

export const config = {
  nodeUrl: required("VITE_PUBLIC_NODE_URL"),
  burnerAddress: required("VITE_PUBLIC_BURNER_ADDRESS"),
  burnerPrivateKey: required("VITE_PUBLIC_BURNER_PRIVATE_KEY"),
  actionsAddress: required("VITE_PUBLIC_ACTIONS_ADDRESS"),
};
