import * as THREE from 'three';
import { createNoise2D, createNoise3D } from 'simplex-noise';
import { Chunk, CHUNK_SIZE, BLOCK_SIZE } from './Chunk';
import { BlockType } from './Block';
import { TextureManager } from '../utils/TextureManager';

// Constants for world generation
const RENDER_DISTANCE = 8; // Chunks
const WORLD_HEIGHT = 4; // Chunks
const TERRAIN_SCALE = 0.01;
const BIOME_SCALE = 0.005;
const CAVE_SCALE = 0.03;
const CAVE_THRESHOLD = 0.3;
const TREE_DENSITY = 0.005;
const WATER_LEVEL = 12;

// Biome types
enum BiomeType {
    PLAINS,
    FOREST,
    DESERT,
    MOUNTAINS,
    SNOW
}

// Ore generation parameters
interface OreConfig {
    blockType: BlockType;
    frequency: number;
    minHeight: number;
    maxHeight: number;
    size: number;
}

export class World {
    private chunks: Map<string, Chunk> = new Map();
    private scene: THREE.Scene;
    private textureManager: TextureManager;
    private noise2D: (x: number, y: number) => number;
    private noise3D: (x: number, y: number, z: number) => number;
    private biomeNoise: (x: number, y: number) => number;
    private blockMaterials: Record<string, THREE.Material>;
    
    // Ore configurations
    private oreConfigs: OreConfig[] = [
        {
            blockType: BlockType.COAL_ORE,
            frequency: 0.1,
            minHeight: 5,
            maxHeight: 80,
            size: 8
        },
        {
            blockType: BlockType.IRON_ORE,
            frequency: 0.05,
            minHeight: 5,
            maxHeight: 60,
            size: 6
        },
        {
            blockType: BlockType.GOLD_ORE,
            frequency: 0.02,
            minHeight: 5,
            maxHeight: 30,
            size: 4
        }
    ];
    
    constructor(scene: THREE.Scene) {
        this.scene = scene;
        this.textureManager = new TextureManager();
        
        // TextureManager constructor already tries to load the atlas.png
        // and creates a fallback if it fails
        
        // Initialize noise functions
        this.noise2D = createNoise2D();
        this.noise3D = createNoise3D();
        this.biomeNoise = createNoise2D();
        
        // Get block materials from texture manager
        this.blockMaterials = this.textureManager.getBlockMaterials();
        
        // Add lighting
        this.setupLighting();
        
        // Enable shadows on block materials
        for (const material of Object.values(this.blockMaterials)) {
            // These properties don't exist on Material directly
            // We'll need to set them when creating the actual meshes instead
            
            // For MeshBasicMaterial and similar materials, we can set some properties
            // that affect shadow appearance
            if (material instanceof THREE.MeshStandardMaterial || 
                material instanceof THREE.MeshPhongMaterial ||
                material instanceof THREE.MeshLambertMaterial) {
                material.shadowSide = THREE.FrontSide;
            }
        }
    }
    
    public generate(): void {
        console.log('Generating chunks around origin...');
        // Generate chunks around origin
        for (let x = -RENDER_DISTANCE; x <= RENDER_DISTANCE; x++) {
            for (let z = -RENDER_DISTANCE; z <= RENDER_DISTANCE; z++) {
                for (let y = 0; y < WORLD_HEIGHT; y++) {
                    this.generateChunk(x, y, z);
                }
            }
        }
        console.log(`Generated ${this.chunks.size} chunks`);
    }
    
    public update(deltaTime: number, playerPosition: THREE.Vector3): void {
        // Convert player position to chunk coordinates
        const chunkX = Math.floor(playerPosition.x / (CHUNK_SIZE * BLOCK_SIZE));
        const chunkY = Math.floor(playerPosition.y / (CHUNK_SIZE * BLOCK_SIZE));
        const chunkZ = Math.floor(playerPosition.z / (CHUNK_SIZE * BLOCK_SIZE));
        
        // Update visible chunks
        for (const [key, chunk] of this.chunks) {
            chunk.update();
        }
        
        // Load/unload chunks based on player position
        this.updateChunks(chunkX, chunkY, chunkZ);
    }
    
    public getBlock(x: number, y: number, z: number): BlockType {
        // Convert world coordinates to chunk coordinates
        const chunkX = Math.floor(x / CHUNK_SIZE);
        const chunkY = Math.floor(y / CHUNK_SIZE);
        const chunkZ = Math.floor(z / CHUNK_SIZE);
        
        // Get local coordinates within the chunk
        const localX = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localY = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localZ = ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        
        // Get the chunk
        const chunk = this.getChunk(chunkX, chunkY, chunkZ);
        if (!chunk) {
            return BlockType.AIR;
        }
        
        return chunk.getBlock(localX, localY, localZ);
    }
    
    public setBlock(x: number, y: number, z: number, type: BlockType): void {
        // Convert world coordinates to chunk coordinates
        const chunkX = Math.floor(x / CHUNK_SIZE);
        const chunkY = Math.floor(y / CHUNK_SIZE);
        const chunkZ = Math.floor(z / CHUNK_SIZE);
        
        // Get local coordinates within the chunk
        const localX = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localY = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localZ = ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        
        // Get the chunk
        const chunk = this.getChunk(chunkX, chunkY, chunkZ);
        if (!chunk) {
            return;
        }
        
        // Get the current block type before changing it
        const oldBlockType = this.getBlock(x, y, z);
        
        // Only proceed if we're actually changing the block
        if (oldBlockType === type) {
            return;
        }
        
        // Set the block in the chunk
        chunk.setBlock(localX, localY, localZ, type);
        
        // Mark this chunk as dirty
        chunk.markDirty();
        
        // Whether the block is on a chunk boundary
        const isOnXBoundary = localX === 0 || localX === CHUNK_SIZE - 1;
        const isOnYBoundary = localY === 0 || localY === CHUNK_SIZE - 1;
        const isOnZBoundary = localZ === 0 || localZ === CHUNK_SIZE - 1;
        
        // CRITICAL FIX: Always update adjacent chunks when mining a block
        // This ensures that faces are properly shown when blocks are removed
        if (type === BlockType.AIR || isOnXBoundary || isOnYBoundary || isOnZBoundary) {
            // Get the 6 directly adjacent chunks (not diagonals)
            const adjacentChunks: Chunk[] = [];
            
            // Add the main chunk
            adjacentChunks.push(chunk);
            
            // Add the 6 directly adjacent chunks if they exist
            if (localX === 0) {
                const leftChunk = this.getChunk(chunkX - 1, chunkY, chunkZ);
                if (leftChunk) adjacentChunks.push(leftChunk);
            }
            
            if (localX === CHUNK_SIZE - 1) {
                const rightChunk = this.getChunk(chunkX + 1, chunkY, chunkZ);
                if (rightChunk) adjacentChunks.push(rightChunk);
            }
            
            if (localY === 0) {
                const bottomChunk = this.getChunk(chunkX, chunkY - 1, chunkZ);
                if (bottomChunk) adjacentChunks.push(bottomChunk);
            }
            
            if (localY === CHUNK_SIZE - 1) {
                const topChunk = this.getChunk(chunkX, chunkY + 1, chunkZ);
                if (topChunk) adjacentChunks.push(topChunk);
            }
            
            if (localZ === 0) {
                const frontChunk = this.getChunk(chunkX, chunkY, chunkZ - 1);
                if (frontChunk) adjacentChunks.push(frontChunk);
            }
            
            if (localZ === CHUNK_SIZE - 1) {
                const backChunk = this.getChunk(chunkX, chunkY, chunkZ + 1);
                if (backChunk) adjacentChunks.push(backChunk);
            }
            
            // For air blocks (mining), we need to update a slightly larger area
            // but don't go overboard with a huge radius
            if (type === BlockType.AIR) {
                // If this block is at a corner of a chunk, make sure diagonal chunks get updated too
                if ((localX === 0 || localX === CHUNK_SIZE - 1) && 
                    (localZ === 0 || localZ === CHUNK_SIZE - 1)) {
                    // Add the diagonal chunk
                    const dx = localX === 0 ? -1 : 1;
                    const dz = localZ === 0 ? -1 : 1;
                    const diagonalChunk = this.getChunk(chunkX + dx, chunkY, chunkZ + dz);
                    if (diagonalChunk) adjacentChunks.push(diagonalChunk);
                }
                
                // Also handle edge cases (edges but not corners)
                if (localX === 0 || localX === CHUNK_SIZE - 1) {
                    if (localY === 0 || localY === CHUNK_SIZE - 1) {
                        // XY-diagonal chunk
                        const dx = localX === 0 ? -1 : 1;
                        const dy = localY === 0 ? -1 : 1;
                        const diagChunk = this.getChunk(chunkX + dx, chunkY + dy, chunkZ);
                        if (diagChunk) adjacentChunks.push(diagChunk);
                    }
                }
                
                if (localZ === 0 || localZ === CHUNK_SIZE - 1) {
                    if (localY === 0 || localY === CHUNK_SIZE - 1) {
                        // ZY-diagonal chunk
                        const dz = localZ === 0 ? -1 : 1;
                        const dy = localY === 0 ? -1 : 1;
                        const diagChunk = this.getChunk(chunkX, chunkY + dy, chunkZ + dz);
                        if (diagChunk) adjacentChunks.push(diagChunk);
                    }
                }
                
                // Handle triple corner case (a block at the corner of 8 chunks)
                if ((localX === 0 || localX === CHUNK_SIZE - 1) && 
                    (localY === 0 || localY === CHUNK_SIZE - 1) && 
                    (localZ === 0 || localZ === CHUNK_SIZE - 1)) {
                    const dx = localX === 0 ? -1 : 1;
                    const dy = localY === 0 ? -1 : 1;
                    const dz = localZ === 0 ? -1 : 1;
                    const cornerChunk = this.getChunk(chunkX + dx, chunkY + dy, chunkZ + dz);
                    if (cornerChunk) adjacentChunks.push(cornerChunk);
                }
            }
            
            // Mark all these chunks as dirty
            adjacentChunks.forEach(chunk => chunk.markDirty());
            
            // Now update all affected chunks
            // This is the key fix - we mark all chunks dirty first, THEN update them all
            // This ensures consistent state when chunks query each other
            adjacentChunks.forEach(chunk => chunk.update());
        }
    }
    
    // This method ensures all pending block data is consistent before rebuilding meshes
    private flushBlockUpdates(): void {
        // This is a synchronization point to ensure block data is consistent
        // For now it's a no-op since our updates are already synchronous,
        // but it provides a hook for more complex scenarios in the future
        console.log("Flushing block updates to ensure consistency");
    }
    
    public raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number = 10): { position: THREE.Vector3, normal: THREE.Vector3, blockType: BlockType } | null {
        try {
            // Validate input parameters
            if (!origin || !direction) {
                console.error('Invalid raycast parameters:', { origin, direction });
                return null;
            }
            
            if (isNaN(origin.x) || isNaN(origin.y) || isNaN(origin.z) || 
                isNaN(direction.x) || isNaN(direction.y) || isNaN(direction.z)) {
                console.error('NaN values in raycast parameters:', { origin, direction });
                return null;
            }
            
            // Raycast implementation using DDA algorithm
            const rayStart = origin.clone();
            const rayDir = direction.clone().normalize();
            
            // Current block position
            const blockPos = new THREE.Vector3(
                Math.floor(rayStart.x),
                Math.floor(rayStart.y),
                Math.floor(rayStart.z)
            );
            
            // Direction to step in each dimension (1 or -1)
            const step = new THREE.Vector3(
                rayDir.x > 0 ? 1 : -1,
                rayDir.y > 0 ? 1 : -1,
                rayDir.z > 0 ? 1 : -1
            );
            
            // Distance from current position to next grid boundary
            const tDelta = new THREE.Vector3(
                rayDir.x === 0 ? Infinity : Math.abs(1 / rayDir.x),
                rayDir.y === 0 ? Infinity : Math.abs(1 / rayDir.y),
                rayDir.z === 0 ? Infinity : Math.abs(1 / rayDir.z)
            );
            
            // Distance to next boundary
            const dist = new THREE.Vector3(
                step.x > 0 ? (Math.floor(rayStart.x) + 1 - rayStart.x) : (rayStart.x - Math.floor(rayStart.x)),
                step.y > 0 ? (Math.floor(rayStart.y) + 1 - rayStart.y) : (rayStart.y - Math.floor(rayStart.y)),
                step.z > 0 ? (Math.floor(rayStart.z) + 1 - rayStart.z) : (rayStart.z - Math.floor(rayStart.z))
            );
            
            // Initial tMax
            const tMax = new THREE.Vector3(
                dist.x === 0 ? 0 : dist.x * tDelta.x,
                dist.y === 0 ? 0 : dist.y * tDelta.y,
                dist.z === 0 ? 0 : dist.z * tDelta.z
            );
            
            // Normal vector for the face that was hit
            const normal = new THREE.Vector3(0, 0, 0);
            
            // Maximum number of iterations
            const maxIterations = Math.ceil(maxDistance * 3);
            
            // Perform raycast
            for (let i = 0; i < maxIterations; i++) {
                // Check current block
                const blockType = this.getBlock(blockPos.x, blockPos.y, blockPos.z);
                
                // If we hit a solid block, return the hit information
                if (blockType !== BlockType.AIR && blockType !== BlockType.WATER) {
                    return {
                        position: blockPos.clone(),
                        normal: normal.clone(),
                        blockType
                    };
                }
                
                // Move to next block
                if (tMax.x < tMax.y && tMax.x < tMax.z) {
                    blockPos.x += step.x;
                    tMax.x += tDelta.x;
                    normal.set(-step.x, 0, 0);
                } else if (tMax.y < tMax.z) {
                    blockPos.y += step.y;
                    tMax.y += tDelta.y;
                    normal.set(0, -step.y, 0);
                } else {
                    blockPos.z += step.z;
                    tMax.z += tDelta.z;
                    normal.set(0, 0, -step.z);
                }
                
                // Check if we've gone too far
                const distance = origin.distanceTo(blockPos);
                if (distance > maxDistance) {
                    return null;
                }
            }
            
            return null;
        } catch (error) {
            console.error('Error in raycast method:', error);
            return null;
        }
    }
    
    private getChunkKey(x: number, y: number, z: number): string {
        return `${x},${y},${z}`;
    }
    
    private getChunk(x: number, y: number, z: number): Chunk | undefined {
        const key = this.getChunkKey(x, y, z);
        return this.chunks.get(key);
    }
    
    private generateChunk(x: number, y: number, z: number): Chunk {
        const chunkKey = `${x},${y},${z}`;
        
        // Check if chunk already exists
        if (this.chunks.has(chunkKey)) {
            return this.chunks.get(chunkKey)!;
        }
        
        // Create new chunk with a callback to get blocks from neighboring chunks
        const chunk = new Chunk(
            x, y, z, 
            this.scene, 
            this.textureManager, 
            (worldX, worldY, worldZ) => this.getBlock(worldX, worldY, worldZ)
        );
        
        // Add to chunks map
        this.chunks.set(chunkKey, chunk);
        
        // Generate terrain for the chunk
        this.generateTerrain(chunk, x, y, z);
        
        // Generate structures
        this.generateStructures(chunk, x, y, z);
        
        return chunk;
    }
    
    private generateTerrain(chunk: Chunk, chunkX: number, chunkY: number, chunkZ: number): void {
        const worldX = chunkX * CHUNK_SIZE;
        const worldY = chunkY * CHUNK_SIZE;
        const worldZ = chunkZ * CHUNK_SIZE;
        
        // Generate terrain for each block in the chunk
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                // Determine biome
                const biomeX = (worldX + x) * BIOME_SCALE;
                const biomeZ = (worldZ + z) * BIOME_SCALE;
                const biomeValue = this.biomeNoise(biomeX, biomeZ);
                const biome = this.getBiomeFromNoise(biomeValue);
                
                // Generate height map using 2D noise
                const nx = (worldX + x) * TERRAIN_SCALE;
                const nz = (worldZ + z) * TERRAIN_SCALE;
                
                // Use multiple octaves of noise for more natural terrain
                let height = 0;
                height += this.noise2D(nx, nz) * 32;
                height += this.noise2D(nx * 2, nz * 2) * 16;
                height += this.noise2D(nx * 4, nz * 4) * 8;
                height += this.noise2D(nx * 8, nz * 8) * 4;
                
                // Apply biome-specific height modifications
                switch (biome) {
                    case BiomeType.PLAINS:
                        height = (height + 64) / 2;
                        break;
                    case BiomeType.FOREST:
                        height = (height + 68) / 2;
                        break;
                    case BiomeType.DESERT:
                        height = (height + 60) / 2;
                        break;
                    case BiomeType.MOUNTAINS:
                        height = (height + 90) / 2;
                        break;
                    case BiomeType.SNOW:
                        height = (height + 70) / 2;
                        break;
                }
                
                height = Math.floor(height);
                
                // Generate blocks for this column
                for (let y = 0; y < CHUNK_SIZE; y++) {
                    const worldBlockY = worldY + y;
                    
                    // Skip if outside height range
                    if (worldBlockY > height + 1) {
                        // Add water if below water level
                        if (worldBlockY <= WATER_LEVEL && biome !== BiomeType.DESERT) {
                            chunk.setBlock(x, y, z, BlockType.WATER);
                        }
                        continue;
                    }
                    
                    // Generate caves using 3D noise
                    const cave = this.noise3D(
                        (worldX + x) * CAVE_SCALE,
                        (worldY + y) * CAVE_SCALE,
                        (worldZ + z) * CAVE_SCALE
                    );
                    
                    if (cave > CAVE_THRESHOLD && worldBlockY < height - 2) {
                        // Cave
                        continue;
                    }
                    
                    // Determine block type based on biome, depth and height
                    let blockType: BlockType;
                    
                    if (worldBlockY === height) {
                        // Surface layer based on biome
                        switch (biome) {
                            case BiomeType.PLAINS:
                                blockType = worldBlockY > WATER_LEVEL ? BlockType.GRASS : BlockType.DIRT;
                                break;
                            case BiomeType.FOREST:
                                blockType = worldBlockY > WATER_LEVEL ? BlockType.GRASS : BlockType.DIRT;
                                break;
                            case BiomeType.DESERT:
                                blockType = BlockType.SAND;
                                break;
                            case BiomeType.MOUNTAINS:
                                blockType = worldBlockY > 60 ? BlockType.SNOW : 
                                           worldBlockY > WATER_LEVEL ? BlockType.STONE : BlockType.GRAVEL;
                                break;
                            case BiomeType.SNOW:
                                blockType = BlockType.SNOW;
                                break;
                            default:
                                blockType = BlockType.GRASS;
                        }
                    } else if (worldBlockY > height - 3) {
                        // Subsurface layer based on biome
                        switch (biome) {
                            case BiomeType.PLAINS:
                            case BiomeType.FOREST:
                                blockType = BlockType.DIRT;
                                break;
                            case BiomeType.DESERT:
                                blockType = worldBlockY > height - 2 ? BlockType.SAND : BlockType.SANDSTONE;
                                break;
                            case BiomeType.MOUNTAINS:
                                blockType = worldBlockY > 60 ? BlockType.DIRT : BlockType.STONE;
                                break;
                            case BiomeType.SNOW:
                                blockType = worldBlockY > height - 2 ? BlockType.SNOW : BlockType.DIRT;
                                break;
                            default:
                                blockType = BlockType.DIRT;
                        }
                    } else if (worldBlockY > height - 8) {
                        // Stone with occasional dirt or clay
                        if (worldBlockY <= WATER_LEVEL + 2 && Math.random() < 0.2) {
                            blockType = BlockType.CLAY;
                        } else if (Math.random() < 0.1) {
                            blockType = BlockType.DIRT;
                        } else {
                            blockType = BlockType.STONE;
                        }
                    } else if (worldBlockY < 5) {
                        // Bedrock near bottom
                        blockType = Math.random() < 0.7 ? BlockType.STONE : BlockType.BEDROCK;
                    } else {
                        // Stone with potential ore veins
                        blockType = this.generateOre(worldX + x, worldY + y, worldZ + z) || BlockType.STONE;
                    }
                    
                    // Set the block
                    chunk.setBlock(x, y, z, blockType);
                    
                    // Generate trees on grass blocks in appropriate biomes
                    if (blockType === BlockType.GRASS && 
                        (biome === BiomeType.PLAINS || biome === BiomeType.FOREST) && 
                        Math.random() < (biome === BiomeType.FOREST ? TREE_DENSITY * 3 : TREE_DENSITY)) {
                        this.generateTree(worldX + x, height + 1, worldZ + z);
                    }
                }
            }
        }
    }
    
    private getBiomeFromNoise(noise: number): BiomeType {
        // Map noise value (-1 to 1) to biome type
        if (noise < -0.6) {
            return BiomeType.DESERT;
        } else if (noise < -0.2) {
            return BiomeType.PLAINS;
        } else if (noise < 0.2) {
            return BiomeType.FOREST;
        } else if (noise < 0.6) {
            return BiomeType.MOUNTAINS;
        } else {
            return BiomeType.SNOW;
        }
    }
    
    private generateOre(x: number, y: number, z: number): BlockType | null {
        // Check each ore configuration
        for (const ore of this.oreConfigs) {
            // Skip if outside height range
            if (y < ore.minHeight || y > ore.maxHeight) {
                continue;
            }
            
            // Use 3D noise to determine ore placement
            const noise = this.noise3D(
                x * 0.1,
                y * 0.1,
                z * 0.1
            );
            
            // Generate ore if noise value is within frequency range
            if (noise > 1 - ore.frequency) {
                return ore.blockType;
            }
        }
        
        return null;
    }
    
    private generateTree(x: number, y: number, z: number): void {
        // Tree trunk height (4-6 blocks)
        const trunkHeight = 4 + Math.floor(Math.random() * 3);
        
        // Generate trunk
        for (let i = 0; i < trunkHeight; i++) {
            this.setBlock(x, y + i, z, BlockType.WOOD);
        }
        
        // Generate leaves
        const leavesStart = trunkHeight - 2;
        const leavesHeight = 4;
        const leavesRadius = 2;
        
        for (let ly = 0; ly < leavesHeight; ly++) {
            const radius = ly === 0 || ly === leavesHeight - 1 ? leavesRadius - 1 : leavesRadius;
            
            for (let lx = -radius; lx <= radius; lx++) {
                for (let lz = -radius; lz <= radius; lz++) {
                    // Skip corners for a more rounded shape
                    if (Math.abs(lx) === radius && Math.abs(lz) === radius) {
                        continue;
                    }
                    
                    // Skip the trunk
                    if (lx === 0 && lz === 0 && ly < leavesHeight - 1) {
                        continue;
                    }
                    
                    this.setBlock(x + lx, y + leavesStart + ly, z + lz, BlockType.LEAVES);
                }
            }
        }
    }
    
    private updateChunks(playerChunkX: number, playerChunkY: number, playerChunkZ: number): void {
        // Load chunks within render distance
        for (let x = playerChunkX - RENDER_DISTANCE; x <= playerChunkX + RENDER_DISTANCE; x++) {
            for (let z = playerChunkZ - RENDER_DISTANCE; z <= playerChunkZ + RENDER_DISTANCE; z++) {
                for (let y = 0; y < WORLD_HEIGHT; y++) {
                    const key = this.getChunkKey(x, y, z);
                    
                    // Check if chunk is already loaded
                    if (!this.chunks.has(key)) {
                        this.generateChunk(x, y, z);
                    }
                }
            }
        }
        
        // Unload chunks outside render distance
        const chunksToRemove: string[] = [];
        
        for (const [key, chunk] of this.chunks) {
            const pos = chunk.getPosition();
            const distance = Math.max(
                Math.abs(pos.x - playerChunkX),
                Math.abs(pos.z - playerChunkZ)
            );
            
            if (distance > RENDER_DISTANCE + 2) {
                chunksToRemove.push(key);
            }
        }
        
        // Remove chunks
        for (const key of chunksToRemove) {
            const chunk = this.chunks.get(key);
            if (chunk) {
                chunk.dispose();
                this.chunks.delete(key);
            }
        }
    }
    
    private setupLighting(): void {
        console.log('Setting up lighting...');
        
        // Add ambient light
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);
        
        // Add directional light (sun)
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(100, 100, 50);
        directionalLight.castShadow = true;
        
        // Configure shadow properties
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        directionalLight.shadow.camera.near = 0.5;
        directionalLight.shadow.camera.far = 500;
        
        this.scene.add(directionalLight);
        
        console.log('Lighting setup complete');
    }
    
    private generateStructures(chunk: Chunk, chunkX: number, chunkY: number, chunkZ: number): void {
        // Skip if not at surface level
        if (chunkY !== 0) {
            return;
        }
        
        const worldX = chunkX * CHUNK_SIZE;
        const worldY = chunkY * CHUNK_SIZE;
        const worldZ = chunkZ * CHUNK_SIZE;
        
        // Generate trees
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                // Get biome at this position
                const biome = this.getBiome(worldX + x, worldZ + z);
                
                // Only generate trees in forest biome with higher probability
                // and plains biome with lower probability
                let treeProbability = 0;
                if (biome === BiomeType.FOREST) {
                    treeProbability = TREE_DENSITY * 3;
                } else if (biome === BiomeType.PLAINS) {
                    treeProbability = TREE_DENSITY;
                }
                
                // Random chance to generate a tree
                if (Math.random() < treeProbability) {
                    // Find surface height
                    let surfaceY = 0;
                    for (let y = CHUNK_SIZE - 1; y >= 0; y--) {
                        const blockType = chunk.getBlock(x, y, z);
                        if (blockType === BlockType.GRASS || blockType === BlockType.DIRT) {
                            surfaceY = y + 1; // Position on top of the ground
                            break;
                        }
                    }
                    
                    // Skip if no suitable surface found or too close to chunk top
                    if (surfaceY === 0 || surfaceY > CHUNK_SIZE - 6) {
                        continue;
                    }
                    
                    // Generate tree at world coordinates
                    this.generateTree(worldX + x, worldY + surfaceY, worldZ + z);
                }
            }
        }
    }
    
    private getBiome(x: number, z: number): BiomeType {
        const biomeValue = this.biomeNoise(x * BIOME_SCALE, z * BIOME_SCALE);
        return this.getBiomeFromNoise(biomeValue);
    }
    
    private createChunkMesh(chunk: Chunk): THREE.Mesh {
        // Get the geometry and materials from the chunk
        const geometry = new THREE.BufferGeometry();
        
        // Create buffer attributes for positions, normals, uvs
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        
        // Build the geometry data
        // This would typically be done by iterating through blocks in the chunk
        // and adding faces for visible blocks
        
        // Set buffer attributes
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        
        // Get materials from texture manager
        const materialRecord = this.textureManager.getBlockMaterials();
        
        // Convert the material record to an array or use a single material
        // Option 1: Use a single material (e.g., the first one)
        const material = Object.values(materialRecord)[0] || new THREE.MeshStandardMaterial();
        
        // Option 2: Use an array of materials (if you need multiple materials)
        // const materials = Object.values(materialRecord);
        
        // Create the mesh with a single material
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        
        return mesh;
    }
} 