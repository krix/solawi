import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MatTableModule } from '@angular/material/table';

interface Depot {
  name: string;
  halfShares: number;
  fullShares: number;
  shares: number;
  persons: number;
  shareFactor: number;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, MatTableModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  depots: Depot[] = [];
  displayedColumns: string[] = ['depot', 'half-shares', 'full-shares', 'persons'];

  constructor() {
    this.addDepot('Wiesbaden', 6, 2);
    this.addDepot('Trebur', 10, 1);
    this.addDepot('Nauheim', 7, 3);
    this.addDepot('Raunheim', 8, 2);

    this.depots.forEach(depot => this.calculateShareFactor(depot));
  }

  private addDepot(name: string, halfShares: number, fullShares: number) {
    this.depots.push({
      name: name,
      halfShares: halfShares,
      fullShares: fullShares,
      shares: halfShares + fullShares * 2,
      persons: halfShares + fullShares,
      shareFactor: 1
    });
  }

  private calculateShareFactor(depot: Depot) {
    const totalShares = this.depots.reduce((previousValue, currentValue) => {
      return previousValue + currentValue.shares;
    }, 0);

    depot.shareFactor = depot.shares / totalShares;
  }
}
