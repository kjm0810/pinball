import { render, screen } from '@testing-library/react';
import App from './App';

test('renders pachinko board', () => {
  render(<App />);
  expect(screen.getByText(/보유 크레딧/)).toBeInTheDocument();
});
