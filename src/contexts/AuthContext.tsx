import React, { createContext, useContext, ReactNode } from 'react';

// Fixed USER_ID for single-user MVP
const FIXED_USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';

interface User {
  id: string;
  email?: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Mock authenticated state with fixed user
  const mockUser: User = {
    id: FIXED_USER_ID,
    email: 'trader@atlasbot.local'
  };

  const value: AuthContextType = {
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Helper to get user ID directly
export function useUserId(): string {
  const { user } = useAuth();
  return user?.id || FIXED_USER_ID;
}

// Export the fixed user ID for use in other places
export { FIXED_USER_ID };
