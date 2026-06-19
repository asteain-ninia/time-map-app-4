// UI layer: React UI shell. May import domain and render only.
// This unit renders an empty window shell; business UI arrives later.
export function App(): JSX.Element {
  return <div id="app-shell" />;
}
