import { render, screen } from '@testing-library/react';
import App from './App';

test('renders pachinko board', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: /설정/ })).toBeInTheDocument();
});
