'use client'

import { Suspense } from 'react'
import HistoricalDataSync from '@/components/HistoricalDataSync'
import { ConvexProvider, convex } from '@/lib/convex'
import { Id } from '../../../convex/_generated/dataModel'

// This would typically come from your routing params or user session
// For demo purposes, using a placeholder ID
const DEMO_LEAGUE_ID = "your_league_id_here" as Id<"leagues">

export default function SyncPage() {
  return (
    <ConvexProvider client={convex}>
      <div className="min-h-screen bg-gray-100 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">League Data Sync</h1>
            <p className="mt-2 text-gray-600">
              Sync historical league data from ESPN Fantasy Football
            </p>
          </div>

          <Suspense fallback={
            <div className="flex items-center justify-center p-8">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            </div>
          }>
            <HistoricalDataSync 
              leagueId={DEMO_LEAGUE_ID}
              leagueName="Demo League"
            />
          </Suspense>

          <div className="mt-8 p-6 bg-white rounded-lg shadow">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">What gets synced?</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div>
                <h4 className="font-medium text-gray-900 mb-2">Team Data</h4>
                <ul className="text-sm text-gray-600 space-y-1">
                  <li>• Team names, logos, abbreviations</li>
                  <li>• Owner information</li>
                  <li>• Win/loss records</li>
                  <li>• Points for/against</li>
                  <li>• Division standings</li>
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-gray-900 mb-2">League History</h4>
                <ul className="text-sm text-gray-600 space-y-1">
                  <li>• Champions & runners-up</li>
                  <li>• Regular season champions</li>
                  <li>• League settings by year</li>
                  <li>• Draft information</li>
                  <li>• Playoff results</li>
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-gray-900 mb-2">Player Data</h4>
                <ul className="text-sm text-gray-600 space-y-1">
                  <li>• Current rosters (current season)</li>
                  <li>• Player statistics</li>
                  <li>• Ownership percentages</li>
                  <li>• Position eligibility</li>
                  <li>• Injury status</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div className="flex">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-yellow-800">Important Notes</h3>
                <div className="mt-2 text-sm text-yellow-700">
                  <ul className="list-disc space-y-1 ml-4">
                    <li>Historical data may be limited for older seasons</li>
                    <li>Private leagues require valid ESPN S2 cookies</li>
                    <li>Large syncs may take several minutes to complete</li>
                    <li>Rate limiting prevents ESPN API overload</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ConvexProvider>
  )
}