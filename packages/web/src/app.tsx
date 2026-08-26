/*
  Dashboard shell + routes. The full product lives here: the report-card
  grid, per-report parameter pages, the query builder with the live DSL
  string, the Live Board, and the data/freshness view. Every number renders
  with N and its CI: the UI has no bare-percentage mode.
*/
import { Route, Switch } from "wouter";
import { Shell } from "./components/layout";
import { EmptyState } from "./components/ui";
import { BuilderPage } from "./pages/builder";
import { DataPage } from "./pages/data";
import { LivePage } from "./pages/live";
import { ReportPage } from "./pages/report";
import { ReportsPage } from "./pages/reports";

export function App() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={ReportsPage} />
        <Route path="/report/:id" component={ReportPage} />
        <Route path="/builder" component={BuilderPage} />
        <Route path="/live" component={LivePage} />
        <Route path="/data" component={DataPage} />
        <Route>
          <EmptyState title="Nothing at this address">
            <p>Pick a page from the navigation above. Reports, Builder, Live, or Data.</p>
          </EmptyState>
        </Route>
      </Switch>
    </Shell>
  );
}
